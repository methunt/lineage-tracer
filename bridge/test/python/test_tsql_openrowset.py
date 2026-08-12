"""
Regression tests for three T-SQL/Synapse-specific lineage bugs, each
demonstrated on small synthetic manifests rather than any real project data:

1. ``OPENROWSET(BULK '...', DATA_SOURCE = ..., FORMAT = 'PARQUET') WITH (...)``
   reads an external data-lake file directly. sqlglot's tsql grammar cannot
   parse its BULK/DATA_SOURCE/FORMAT option syntax (nor the OPENROWSET-only
   WITH schema clause that can follow it), which raised a ParseError that
   killed lineage extraction for the *entire* model, not just that one
   unparseable table reference.

2. A big ``UNION ALL`` of many ``SELECT * FROM <table>`` branches, where one
   branch's table can't be resolved against the schema (so its ``*`` never
   expands), crashed with "list index out of range" — because the
   inconsistent arity across union branches broke a position-based column
   lookup — and again killed lineage for every column of the *whole* model,
   including all of its genuinely-resolvable sibling branches.

3. A parent referenced as a two-part ``schema.table`` (no database/catalog
   prefix) never resolved to its dbt node, even though the schema held only
   one unambiguous database for that schema.table — because sqlglot's
   qualifier fills in the schema but does not backfill the catalog, and the
   lookup key required all three parts. This is the kind of gap that makes a
   real, existing model show up as "unresolved/unknown" despite dbt's own
   docs site resolving it fine from manifest.json alone.

Run directly:      python test_tsql_openrowset.py
Run via the suite: npm test   (bridge/test/run.js shells out to this file)
"""
import json
import os
import sys
import tempfile
import unittest

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO_ROOT, "dbt-colibri", "src"))

from dbt_colibri.lineage_extractor.extractor import DbtColumnLineageExtractor


def _model(name, compiled_code, depends_on, database="SAMPLE_DB", schema="warehouse"):
    return {
        "resource_type": "model",
        "database": database,
        "schema": schema,
        "name": name,
        "alias": name,
        "relation_name": f'"{database}"."{schema}"."{name}"',
        "compiled_code": compiled_code,
        "raw_code": compiled_code,
        "config": {"materialized": "table"},
        "depends_on": {"nodes": depends_on},
        "path": f"models/{name}.sql",
    }


def _catalog_entry(node_id, database, schema, name, columns):
    return {
        "unique_id": node_id,
        "metadata": {"database": database, "schema": schema, "name": name},
        "columns": {
            col: {"index": i + 1, "name": col, "type": "TEXT"}
            for i, col in enumerate(columns)
        },
    }


def _run_extractor(manifest, catalog):
    manifest.setdefault("metadata", {})["adapter_type"] = "sqlserver"
    manifest.setdefault("sources", {})
    catalog.setdefault("sources", {})
    with tempfile.TemporaryDirectory() as tmp:
        manifest_path = os.path.join(tmp, "manifest.json")
        catalog_path = os.path.join(tmp, "catalog.json")
        with open(manifest_path, "w") as f:
            json.dump(manifest, f)
        with open(catalog_path, "w") as f:
            json.dump(catalog, f)
        extractor = DbtColumnLineageExtractor(manifest_path, catalog_path)
        return extractor.extract_project_lineage()


class OpenrowsetTest(unittest.TestCase):
    def test_openrowset_read_does_not_break_the_model(self):
        code = """
SELECT
    result.filepath(1) as loaddate,
    category,
    row_count,
    total_amount
FROM
    openrowset(
    bulk 'sample-lake/example-dataset/partition=*/x.parquet',
    data_source = 'SampleParquetSource',
    format = 'PARQUET'
    ) AS [result]
"""
        manifest = {"nodes": {"model.proj.example_summary": _model("example_summary", code, [])}}
        catalog = {
            "nodes": {
                "model.proj.example_summary": _catalog_entry(
                    "model.proj.example_summary", "SAMPLE_DB", "warehouse",
                    "example_summary", ["loaddate", "category", "row_count", "total_amount"],
                ),
            },
        }

        result = _run_extractor(manifest, catalog)

        self.assertEqual(result["errors"], [])
        self.assertIn("model.proj.example_summary", result["lineage"]["parents"])

    def test_openrowset_with_explicit_column_schema_does_not_break_the_model(self):
        code = """
SELECT [code], [rate]
FROM OPENROWSET(
    BULK 'sample-lake/example-reference-data/**',
    DATA_SOURCE = 'SampleParquetSource',
    FORMAT = 'CSV',
    PARSER_VERSION = '2.0'
) WITH (
    [code] varchar(10),
    [rate] decimal(18, 6)
) AS [result]
"""
        manifest = {"nodes": {"model.proj.example_rates": _model("example_rates", code, [])}}
        catalog = {
            "nodes": {
                "model.proj.example_rates": _catalog_entry(
                    "model.proj.example_rates", "SAMPLE_DB", "warehouse",
                    "example_rates", ["code", "rate"],
                ),
            },
        }

        result = _run_extractor(manifest, catalog)

        self.assertEqual(result["errors"], [])
        self.assertIn("model.proj.example_rates", result["lineage"]["parents"])


class UnionArityMismatchTest(unittest.TestCase):
    def test_one_unresolvable_union_branch_does_not_break_the_others(self):
        # region_a_lookup and region_b_lookup are real dbt models; a third
        # union branch (region_x_lookup) is not — it has no manifest node at
        # all, an orphan reference in the SQL itself. Before the fix, that
        # one unresolvable branch's un-expanded `SELECT *` crashed lineage
        # for every column, hiding the two real, resolvable parents too.
        region_a = _model("region_a_lookup", "select * from source_table", [])
        region_b = _model("region_b_lookup", "select * from source_table", [])
        child_code = """
WITH unioned AS (
    SELECT * FROM warehouse.region_a_lookup
    UNION ALL
    SELECT * FROM warehouse.region_b_lookup
    UNION ALL
    SELECT * FROM warehouse.region_x_lookup
)
SELECT * FROM unioned;
"""
        child = _model(
            "combined_lookup_dw", child_code,
            ["model.proj.region_a_lookup", "model.proj.region_b_lookup"],
        )
        manifest = {
            "nodes": {
                "model.proj.region_a_lookup": region_a,
                "model.proj.region_b_lookup": region_b,
                "model.proj.combined_lookup_dw": child,
            },
        }
        catalog = {
            "nodes": {
                "model.proj.region_a_lookup": _catalog_entry(
                    "model.proj.region_a_lookup", "SAMPLE_DB", "warehouse",
                    "region_a_lookup", ["source_key", "target_key"],
                ),
                "model.proj.region_b_lookup": _catalog_entry(
                    "model.proj.region_b_lookup", "SAMPLE_DB", "warehouse",
                    "region_b_lookup", ["source_key", "target_key"],
                ),
                "model.proj.combined_lookup_dw": _catalog_entry(
                    "model.proj.combined_lookup_dw", "SAMPLE_DB", "warehouse",
                    "combined_lookup_dw", ["source_key", "target_key"],
                ),
            },
        }

        result = _run_extractor(manifest, catalog)

        self.assertEqual(result["errors"], [])
        source_key_parents = result["lineage"]["parents"][
            "model.proj.combined_lookup_dw"
        ]["source_key"]
        resolved = {p["dbt_node"] for p in source_key_parents}
        self.assertIn("model.proj.region_a_lookup", resolved)
        self.assertIn("model.proj.region_b_lookup", resolved)


class SchemaTableWithoutCatalogTest(unittest.TestCase):
    def test_two_part_reference_resolves_when_schema_is_unambiguous(self):
        parent = _model("region_a_lookup", "select * from source_table", [])
        child = _model(
            "child_model", "select * from warehouse.region_a_lookup",
            ["model.proj.region_a_lookup"],
        )
        manifest = {
            "nodes": {
                "model.proj.region_a_lookup": parent,
                "model.proj.child_model": child,
            },
        }
        catalog = {
            "nodes": {
                "model.proj.region_a_lookup": _catalog_entry(
                    "model.proj.region_a_lookup", "SAMPLE_DB", "warehouse",
                    "region_a_lookup", ["source_key"],
                ),
                "model.proj.child_model": _catalog_entry(
                    "model.proj.child_model", "SAMPLE_DB", "warehouse",
                    "child_model", ["source_key"],
                ),
            },
        }

        result = _run_extractor(manifest, catalog)

        parents = result["lineage"]["parents"]["model.proj.child_model"]["source_key"]
        resolved = {p["dbt_node"] for p in parents}
        self.assertIn(
            "model.proj.region_a_lookup",
            resolved,
            f"expected the catalog-less 'warehouse.region_a_lookup' reference to "
            f"resolve to the real model even without a database prefix; got {parents}",
        )

    def test_ambiguous_schema_table_across_two_databases_is_not_guessed(self):
        # Two different databases each have their own warehouse.customers.
        # A catalog-less reference to "warehouse.customers" must not silently
        # pick one — that would misattribute lineage to the wrong table.
        a = _model("customers", "select 1 as id", [], database="DB_A")
        b = _model("customers", "select 1 as id", [], database="DB_B")
        child = _model(
            "child_model", "select * from warehouse.customers",
            ["model.proj.customers_a", "model.proj.customers_b"],
            database="DB_A",
        )
        manifest = {
            "nodes": {
                "model.proj.customers_a": a,
                "model.proj.customers_b": b,
                "model.proj.child_model": child,
            },
        }
        catalog = {
            "nodes": {
                "model.proj.customers_a": _catalog_entry(
                    "model.proj.customers_a", "DB_A", "warehouse", "customers", ["id"],
                ),
                "model.proj.customers_b": _catalog_entry(
                    "model.proj.customers_b", "DB_B", "warehouse", "customers", ["id"],
                ),
                "model.proj.child_model": _catalog_entry(
                    "model.proj.child_model", "DB_A", "warehouse", "child_model", ["id"],
                ),
            },
        }

        result = _run_extractor(manifest, catalog)

        # sqlglot's own qualifier refuses to guess here too (it raises
        # "Ambiguous mapping" before this extractor even gets a chance to
        # resolve the table), so child_model may have no lineage recorded at
        # all rather than a populated-but-wrong entry. Either is fine; a
        # confident wrong answer is what must never happen.
        parents = result["lineage"]["parents"].get("model.proj.child_model", {}).get("id", [])
        resolved = {p["dbt_node"] for p in parents}
        self.assertNotIn("model.proj.customers_a", resolved)
        self.assertNotIn("model.proj.customers_b", resolved)


if __name__ == "__main__":
    unittest.main()
