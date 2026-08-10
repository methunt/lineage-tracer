"""
dbt side of the bridge: manifest.json + catalog.json -> our merged-graph schema.

colibri's DbtColumnLineageExtractor is used as a library and never modified — it
does the hard part (sqlglot column-lineage resolution across 12 SQL dialects).
This script replaces colibri's report generator, which shapes output for their
renderer; we shape it for ours (see bridge/docs/ui-spec.md section 3).

Emits JSON on stdout. All logging goes to stderr so stdout stays parseable.
"""
import argparse
import json
import os
import sys

# Pyodide replaces both streams with objects that have no reconfigure(), and
# they are already UTF-8 there — this is only ever needed on a Windows console.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")


def load_extractor(colibri_src, manifest_path, catalog_path):
    sys.path.insert(0, colibri_src)
    try:
        from dbt_colibri.lineage_extractor.extractor import DbtColumnLineageExtractor
    except ImportError as exc:
        die(
            f"could not import dbt_colibri from {colibri_src}: {exc}\n"
            "Install its dependencies (sqlglot, click) or pass --colibri-src."
        )
    class CaseTolerantExtractor(DbtColumnLineageExtractor):
        """
        colibri regenerates the sqlglot schema per model (from a parent-catalog
        subset), so widening the instance attribute is not enough — the override
        has to sit on the generator itself.
        """

        def _generate_schema_dict_from_catalog(self, catalog=None):
            schema = super()._generate_schema_dict_from_catalog(catalog)
            widen_schema_case_dict(schema)
            return schema

    return CaseTolerantExtractor(manifest_path, catalog_path)


def widen_schema_case_dict(schema, _reported=[]):
    """
    Make the sqlglot schema resolvable in either case.

    colibri applies `remove_upper()` to BigQuery SQL, which lowercases *every*
    quoted identifier. That is right for BigQuery's case-insensitive columns but
    also rewrites the dataset: fully-backticked SQL like

        FROM `proj`.`ANALYTICS_DEV`.`dim_customer`

    becomes `analytics_dev`, which no longer matches the schema built
    from the catalog. sqlglot then cannot attach columns to a table, lineage
    leaves come back as bare column names, and colibri silently drops them. On
    a large production project that lost column lineage for the majority of
    models — well over two thirds of them.

    Rather than patch colibri, add lowercase aliases alongside the original keys
    so a lookup succeeds in either case. Aliases are skipped where they would
    collide with a genuinely distinct key.
    """
    if not schema:
        return 0

    added = 0

    def alias(container):
        nonlocal added
        for key in list(container.keys()):
            lower = key.lower()
            if lower == key or lower in container:
                continue
            container[lower] = container[key]   # same object: no duplication
            added += 1

    alias(schema)
    for database in list(schema.values()):
        if isinstance(database, dict):
            alias(database)

    # One line, not one per model.
    if added and not _reported:
        _reported.append(True)
        print("dbt_extract: widened schema keys for case-insensitive lookup "
              "(works around colibri lowercasing quoted BigQuery identifiers)", file=sys.stderr)
    return added


def die(message):
    print(f"dbt_extract: {message}", file=sys.stderr)
    sys.exit(1)


def layer_of(node):
    """
    Layer = the folder path under models/, in full.

    colibri's own detect_model_type() is deliberately not used: its stg_/dim_/fct_
    prefix heuristic returns "unknown" for the majority of nodes on a large
    production project. Folders are complete and unambiguous.

    The whole chain, not just the first segment: on such a project a large
    minority of models sit two folders deep and a handful sit three deep, so
    keeping only the first put `analytics/mapping` and `staging/crm/base` out of
    reach entirely -- they
    were not collapsed into a parent, they were invisible.

    Joined with "/" so a layer stays one comparable string. It is a grouping
    key, a tree path and the canvas axis all at once, and each of those wants a
    value it can sort, compare and use as a map key.

    Models sitting directly in models/ have no folder, and keep the literal name
    `models` -- which is what a reader calls that folder anyway.
    """
    if node.get("resource_type") == "source":
        return "sources"
    path = (node.get("path") or "").replace("\\", "/")
    parts = [p for p in path.split("/") if p][:-1]     # drop the file name
    return "/".join(parts) if parts else "models"


def relation_of(node):
    parts = [node.get("database"), node.get("schema"), node.get("identifier") or node.get("name")]
    return ".".join(str(p) for p in parts if p)


def build_columns(node, catalog_entry, tests_by_column):
    """Union of manifest columns (docs, tests) and catalog columns (real types)."""
    columns = {}

    for name, meta in (node.get("columns") or {}).items():
        columns[name] = {
            "name": name,
            "dataType": meta.get("data_type"),
            "description": meta.get("description") or None,
            "tags": meta.get("tags") or [],
        }

    for name, meta in ((catalog_entry or {}).get("columns") or {}).items():
        entry = columns.setdefault(name, {"name": name, "description": None, "tags": []})
        entry["dataType"] = entry.get("dataType") or meta.get("type")
        entry["ordinal"] = meta.get("index")

    for name, tests in tests_by_column.items():
        if name in columns:
            columns[name]["tests"] = tests

    ordered = sorted(columns.values(), key=lambda c: (c.get("ordinal") is None, c.get("ordinal") or 0, c["name"]))
    for col in ordered:
        col.pop("ordinal", None)
        col.setdefault("hasLineage", False)
        col.setdefault("tests", [])
    return ordered


def index_tests(manifest):
    """node_id -> {column_name -> [test summary]}, plus '__model__' for node-level."""
    index = {}
    for node in manifest.get("nodes", {}).values():
        if node.get("resource_type") != "test":
            continue
        attached = node.get("attached_node")
        if not attached:
            continue
        column = node.get("column_name") or "__model__"
        index.setdefault(attached, {}).setdefault(column, []).append({
            "name": (node.get("test_metadata") or {}).get("name") or node.get("name"),
            "severity": (node.get("config") or {}).get("severity", "error"),
        })
    return index


def extract(extractor, include_sql=True):
    manifest = extractor.manifest
    catalog = extractor.catalog
    tests = index_tests(manifest)

    lineage = extractor.extract_project_lineage()
    parents = lineage["lineage"]["parents"]
    errors = lineage.get("errors", [])

    nodes = {}
    edges = []

    def source_of(node_id):
        return manifest.get("nodes", {}).get(node_id) or manifest.get("sources", {}).get(node_id)

    def ensure(node_id):
        if node_id in nodes:
            return nodes[node_id]
        raw = source_of(node_id)
        if raw is None:
            # Referenced but absent (e.g. hardcoded relation in SQL) — keep it as a
            # stub so the edge is not silently dropped.
            nodes[node_id] = {
                "id": f"dbt:{node_id}", "kind": "unknown", "name": node_id.split(".")[-1],
                "layer": "unknown", "origin": "dbt", "columns": [], "meta": {}, "definition": {},
            }
            return nodes[node_id]

        resource = raw.get("resource_type")
        kind = "source" if resource == "source" else "model"
        node_tests = tests.get(node_id, {})
        catalog_entry = (catalog.get("nodes", {}).get(node_id)
                         or catalog.get("sources", {}).get(node_id))

        definition = {}
        if include_sql:
            if raw.get("compiled_code"):
                definition["compiledSql"] = raw["compiled_code"]
            if raw.get("raw_code"):
                definition["rawSql"] = raw["raw_code"]

        nodes[node_id] = {
            "id": f"dbt:{node_id}",
            "kind": kind,
            "name": raw.get("name") or node_id.split(".")[-1],
            "layer": layer_of(raw),
            "origin": "dbt",
            "columns": build_columns(raw, catalog_entry, node_tests),
            "meta": {
                "resourceType": resource,
                "materialized": (raw.get("config") or {}).get("materialized"),
                "database": raw.get("database"),
                "schema": raw.get("schema"),
                "relation": relation_of(raw),
                "path": raw.get("path"),
                "description": raw.get("description") or None,
                "tags": raw.get("tags") or [],
                "tests": node_tests.get("__model__", []),
                "testCount": sum(len(v) for v in node_tests.values()),
                "sourceName": raw.get("source_name"),
            },
            "definition": definition,
        }
        return nodes[node_id]

    column_flags = {}

    for target_id, columns in parents.items():
        ensure(target_id)
        for target_column, sources in columns.items():
            if target_column.startswith("__colibri"):
                continue  # structural filter edges, not real column lineage
            column_flags.setdefault(target_id, set()).add(target_column.lower())
            for src in sources or []:
                if not isinstance(src, dict):
                    continue
                source_id = src.get("dbt_node")
                source_column = src.get("column")
                if not source_id:
                    continue
                ensure(source_id)
                column_flags.setdefault(source_id, set()).add(str(source_column).lower())
                edges.append({
                    "source": f"dbt:{source_id}",
                    "target": f"dbt:{target_id}",
                    "sourceColumn": source_column,
                    "targetColumn": target_column,
                    "lineageType": src.get("lineage_type"),
                    "provenance": "derived",
                    "matchLevel": "dbt",
                })

    # Every node in the project, including ones with no resolved lineage — a model
    # that reaches nothing is a finding, not something to hide.
    for node_id in list(manifest.get("nodes", {})) + list(manifest.get("sources", {})):
        raw = source_of(node_id)
        if raw and raw.get("resource_type") in {"test", "macro", "operation", "analysis"}:
            continue
        ensure(node_id)

    for node_id, flagged in column_flags.items():
        node = nodes.get(node_id)
        if not node:
            continue
        for column in node["columns"]:
            if column["name"].lower() in flagged:
                column["hasLineage"] = True

    # Every resource type the project declares, whether or not it carries column
    # lineage. Analyses and exposures usually carry none, and a navigation tree
    # that silently omits them is indistinguishable from one that lost them —
    # the UI shows the count and says why the folder is empty.
    declared = {}
    declared_names = {}
    everything = (list(manifest.get("nodes", {}).values())
                  + list(manifest.get("sources", {}).values())
                  + list((manifest.get("exposures") or {}).values()))
    for raw in everything:
        resource = (raw or {}).get("resource_type")
        if not resource or resource in {"macro", "operation"}:
            continue
        declared[resource] = declared.get(resource, 0) + 1
        declared_names.setdefault(resource, []).append(raw.get("name") or "?")

    # Names are only worth carrying for resource types that never reach the
    # lineage graph — for the rest the nodes themselves are richer. Listing the
    # seven analyses by name is the difference between "we know about these and
    # they have no lineage" and "these vanished".
    in_graph = {n["meta"].get("resourceType") for n in nodes.values() if n.get("meta")}
    declared_names = {
        resource: sorted(names)
        for resource, names in declared_names.items()
        if resource not in in_graph
    }

    return {
        "metadata": {
            "dbtVersion": (manifest.get("metadata") or {}).get("dbt_version"),
            "adapter": (manifest.get("metadata") or {}).get("adapter_type"),
            "projectName": (manifest.get("metadata") or {}).get("project_name"),
            "dialect": getattr(extractor, "dialect", None),
            "declaredResources": declared,
            "declaredNames": declared_names,
        },
        "nodes": {n["id"]: n for n in nodes.values()},
        "edges": edges,
        "errors": errors,
    }


def run(manifest_path, catalog_path, colibri_src, include_sql=True):
    """
    One extraction, start to finish. The CLI and the browser both call this.

    Paths, not parsed JSON: colibri's extractor reads the two files itself, and
    the browser mounts them into Pyodide's in-memory filesystem before calling
    in. Reshaping colibri's constructor to take dicts would be a fork of a
    dependency this project deliberately does not modify.
    """
    for path, label in ((manifest_path, "manifest"), (catalog_path, "catalog")):
        if not os.path.exists(path):
            die(f"{label} not found: {path}")

    extractor = load_extractor(colibri_src, manifest_path, catalog_path)
    result = extract(extractor, include_sql=include_sql)

    models = [n for n in result["nodes"].values() if n["kind"] == "model"]
    if models and not result["edges"]:
        print(
            "dbt_extract: warning — 0 column edges resolved. The most common cause is a "
            "manifest without compiled SQL; run `dbt compile` (or dbt run/build) and "
            "re-export target/manifest.json.",
            file=sys.stderr,
        )
    return result


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--catalog", required=True)
    ap.add_argument("--colibri-src", required=True, help="path to dbt-colibri/src")
    ap.add_argument("--no-sql", action="store_true", help="omit compiled/raw SQL from output")
    ap.add_argument("--out", help="write JSON here instead of stdout")
    args = ap.parse_args()

    result = run(args.manifest, args.catalog, args.colibri_src, include_sql=not args.no_sql)

    payload = json.dumps(result, default=str)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(payload)
        print(f"dbt_extract: wrote {args.out}", file=sys.stderr)
    else:
        print(payload)


if __name__ == "__main__":
    main()
