import importlib.util
import pathlib
import unittest


BRIDGE_PATH = pathlib.Path(__file__).with_name("bridge.py")
SPEC = importlib.util.spec_from_file_location("stela_dab_bridge", BRIDGE_PATH)
BRIDGE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(BRIDGE)


class BridgeHelpersTest(unittest.TestCase):
    def test_route_and_strip_database_prefix(self):
        database, query = BRIDGE.parse_routed_query(
            "-- stela-dab-database: books_database\nSELECT * FROM books_database.books_info",
            ["books_database", "review_database"],
        )
        self.assertEqual(database, "books_database")
        self.assertEqual(query, "SELECT * FROM books_info")

    def test_reject_cross_database_query(self):
        with self.assertRaisesRegex(BRIDGE.BridgeError, "only one logical database"):
            BRIDGE.parse_routed_query(
                "-- stela-dab-database: books_database\n"
                "SELECT * FROM books_database.books_info b JOIN review_database.review r ON 1=1",
                ["books_database", "review_database"],
            )

    def test_structured_sql_query(self):
        database, query = BRIDGE.official_query_from_structured(
            {
                "language": "sql",
                "database": "books_database",
                "query": "SELECT * FROM books_database.books_info",
            },
            ["books_database", "review_database"],
        )
        self.assertEqual(database, "books_database")
        self.assertEqual(query, "SELECT * FROM books_info")

    def test_structured_mongodb_find(self):
        database, raw = BRIDGE.official_query_from_structured(
            {
                "language": "mongodb",
                "database": "articles_database",
                "collection": "articles",
                "filter": {"region": "US"},
                "projection": {"title": 1},
                "limit": None,
            },
            ["articles_database"],
        )
        self.assertEqual(database, "articles_database")
        self.assertEqual(
            BRIDGE.json.loads(raw),
            {
                "collection": "articles",
                "filter": {"region": "US"},
                "projection": {"title": 1},
                "limit": None,
            },
        )

    def test_reject_mongodb_server_side_javascript(self):
        with self.assertRaisesRegex(BRIDGE.BridgeError, "server-side JavaScript"):
            BRIDGE.official_query_from_structured(
                {
                    "language": "mongodb",
                    "database": "articles_database",
                    "collection": "articles",
                    "filter": {"$expr": {"$function": {"body": "return true"}}},
                },
                ["articles_database"],
            )

    def test_structured_mongodb_aggregate(self):
        database, raw = BRIDGE.official_query_from_structured(
            {
                "language": "mongodb",
                "operation": "aggregate",
                "database": "articles_database",
                "collection": "articles",
                "pipeline": [
                    {"$match": {"region": "US"}},
                    {"$group": {"_id": "$author", "count": {"$sum": 1}}},
                    {"$sort": {"count": -1}},
                ],
                "limit": 10,
            },
            ["articles_database"],
        )
        self.assertEqual(database, "articles_database")
        parsed = BRIDGE.json.loads(raw)
        self.assertEqual(parsed["operation"], "aggregate")
        self.assertEqual(parsed["pipeline"][1]["$group"]["count"], {"$sum": 1})

    def test_reject_mongodb_aggregate_write_and_javascript(self):
        for pipeline in [
            [{"$out": "copy"}],
            [{"$project": {"x": {"$function": {"body": "return 1"}}}}],
            [{"$lookup": {"from": "other", "as": "rows"}}],
        ]:
            with self.subTest(pipeline=pipeline):
                with self.assertRaises(BRIDGE.BridgeError):
                    BRIDGE.official_query_from_structured(
                        {
                            "language": "mongodb",
                            "operation": "aggregate",
                            "database": "articles_database",
                            "collection": "articles",
                            "pipeline": pipeline,
                        },
                        ["articles_database"],
                    )

    def test_normalize_records(self):
        result = BRIDGE.normalize_query_result(
            [{"name": "a", "score": 1.5}, {"name": "b", "score": 2.0}],
            12,
        )
        self.assertEqual(result["kind"], "query")
        self.assertEqual([column["name"] for column in result["columns"]], ["name", "score"])
        self.assertEqual(result["rows"], [["a", 1.5], ["b", 2.0]])

    def test_extract_description_columns(self):
        description = """1. books_database
   - books_info:
     - Fields:
       - title (str): Book title
       - price (float): Book price
2. review_database
"""
        columns, snippet = BRIDGE.table_description(description, "books_info")
        self.assertIn("books_info", snippet)
        self.assertEqual([column["name"] for column in columns], ["title", "price"])


if __name__ == "__main__":
    unittest.main()
