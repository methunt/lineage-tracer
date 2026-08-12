"""
Regression test: a manifest node missing from catalog.json (stale/partial
`dbt docs generate`, a run that skipped it, etc.) must still resolve as a
lineage parent. dbt's own docs site draws lineage from manifest.json alone,
regardless of catalog.json — this extractor needs the same guarantee, or
nodes that dbt resolves fine show up here as unresolved/unknown stubs.

Run directly:      python test_catalog_fallback.py
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


def _model(name, compiled_code, depends_on, materialized="table"):
    return {
        "resource_type": "model",
        "database": "db",
        "schema": "sch",
        "name": name,
        "alias": name,
        "relation_name": f"db.sch.{name}",
        "compiled_code": compiled_code,
        "config": {"materialized": materialized},
        "depends_on": {"nodes": depends_on},
        "path": f"models/{name}.sql",
    }


def _run_extractor(manifest, catalog):
    with tempfile.TemporaryDirectory() as tmp:
        manifest_path = os.path.join(tmp, "manifest.json")
        catalog_path = os.path.join(tmp, "catalog.json")
        with open(manifest_path, "w") as f:
            json.dump(manifest, f)
        with open(catalog_path, "w") as f:
            json.dump(catalog, f)
        extractor = DbtColumnLineageExtractor(manifest_path, catalog_path)
        return extractor.extract_project_lineage()


class CatalogGapFallbackTest(unittest.TestCase):
    def test_child_resolves_parent_even_when_parent_missing_from_catalog(self):
        manifest = {
            "metadata": {"adapter_type": "snowflake"},
            "nodes": {
                "model.proj.parent_model": _model(
                    "parent_model", "select 1 as id, 'x' as name", []
                ),
                "model.proj.child_model": _model(
                    "child_model", "select * from db.sch.parent_model",
                    ["model.proj.parent_model"],
                ),
            },
            "sources": {},
        }
        # parent_model is intentionally ABSENT from catalog.json: a real,
        # non-ephemeral table whose catalog entry never landed (skipped run,
        # catalog generated before the run finished, etc.).
        catalog = {
            "nodes": {
                "model.proj.child_model": {
                    "unique_id": "model.proj.child_model",
                    "metadata": {"database": "db", "schema": "sch", "name": "child_model"},
                    "columns": {"id": {"index": 1, "name": "id", "type": "NUMBER"}},
                },
            },
            "sources": {},
        }

        result = _run_extractor(manifest, catalog)

        id_parents = result["lineage"]["parents"].get("model.proj.child_model", {}).get("id", [])
        resolved_parent_ids = {p["dbt_node"] for p in id_parents}

        self.assertIn(
            "model.proj.parent_model",
            resolved_parent_ids,
            f"expected child_model.id to resolve to parent_model even though "
            f"parent_model is missing from catalog.json; got parents={id_parents}",
        )

    def test_ephemeral_parent_still_resolves(self):
        # Guards against the fix regressing the pre-existing ephemeral path:
        # ephemeral models never appear in catalog.json by definition, and
        # that must keep working exactly as before.
        manifest = {
            "metadata": {"adapter_type": "snowflake"},
            "nodes": {
                "model.proj.eph_model": _model(
                    "eph_model", "select 1 as id, 'x' as name", [],
                    materialized="ephemeral",
                ),
                "model.proj.child_model": _model(
                    "child_model",
                    "with __dbt__cte__eph_model as (select 1 as id, 'x' as name) "
                    "select * from __dbt__cte__eph_model",
                    ["model.proj.eph_model"],
                ),
            },
            "sources": {},
        }
        catalog = {
            "nodes": {
                "model.proj.child_model": {
                    "unique_id": "model.proj.child_model",
                    "metadata": {"database": "db", "schema": "sch", "name": "child_model"},
                    "columns": {"id": {"index": 1, "name": "id", "type": "NUMBER"}},
                },
            },
            "sources": {},
        }

        result = _run_extractor(manifest, catalog)

        id_parents = result["lineage"]["parents"].get("model.proj.child_model", {}).get("id", [])
        resolved_parent_ids = {p["dbt_node"] for p in id_parents}

        self.assertIn("model.proj.eph_model", resolved_parent_ids)

    def test_node_missing_from_both_manifest_and_catalog_stays_unresolved(self):
        # Sanity check the fallback doesn't overreach: a table referenced in
        # SQL that has no manifest node at all (e.g. a hardcoded relation)
        # must NOT be silently invented — it should simply not resolve here,
        # leaving the "not found" stub behavior in dbt_extract.py intact.
        manifest = {
            "metadata": {"adapter_type": "snowflake"},
            "nodes": {
                "model.proj.child_model": _model(
                    "child_model", "select * from db.sch.totally_untracked_table", [],
                ),
            },
            "sources": {},
        }
        catalog = {
            "nodes": {
                "model.proj.child_model": {
                    "unique_id": "model.proj.child_model",
                    "metadata": {"database": "db", "schema": "sch", "name": "child_model"},
                    "columns": {"id": {"index": 1, "name": "id", "type": "NUMBER"}},
                },
            },
            "sources": {},
        }

        result = _run_extractor(manifest, catalog)

        id_parents = result["lineage"]["parents"].get("model.proj.child_model", {}).get("id", [])
        resolved_parent_ids = {p["dbt_node"] for p in id_parents}

        self.assertNotIn("model.proj.totally_untracked_table", resolved_parent_ids)


if __name__ == "__main__":
    unittest.main()
