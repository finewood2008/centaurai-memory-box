"""Deployment classification is identical at Bridge and native Octop admission."""
import unittest

from centuarai_local_data_gate.native_policy import MIB, check_octop_request, classify_octop
from centuarai_local_data_gate.protocol import DataProtocolError

OPERATION = "a" * 32
TARGET = "organizationId=org-1&boxId=box_1&applicationId=app.example&environment=dev"
PREFIXES = [("/api/app-studio/deployment", "studio", "team:management"),
            ("/api/_client/workshop/deployment", "workshop", "wanx")]
ROUTES = [
    ("GET", "/capabilities", "read", 0), ("POST", "/releases", "write", MIB),
    ("GET", "/operations", "read", 0), ("POST", "/operations", "execute", MIB),
    ("GET", "/operations?" + TARGET + "&limit=100", "read", 0),
    ("GET", "/operations?limit=1", "read", 0),
    ("GET", "/environments?" + TARGET, "read", 0),
    ("GET", "/environments?" + TARGET.replace("dev", "prod"), "read", 0),
    ("GET", "/operations/" + OPERATION, "read", 0),
    ("GET", "/operations/" + OPERATION + "/events", "read", 0),
    ("GET", "/operations/" + OPERATION + "/events?after=0&limit=100", "read", 0),
    ("GET", "/operations/" + OPERATION + "/events?after=9007199254740991", "read", 0),
    ("GET", "/operations/" + OPERATION + "/receipt", "read", 0),
    ("POST", "/operations/" + OPERATION + "/resume", "execute", MIB),
    ("POST", "/operations/" + OPERATION + "/receipt/retry", "execute", MIB),
]


def request_scope(method, target):
    path, _, query = target.partition("?")
    return {"method": method, "type": "http", "path": path,
            "raw_path": path.encode(), "query_string": query.encode()}


def request_claims(family, resource, action, size=0):
    return {"audience": "octop", "applicationId": "wanx-host", "action": action,
            "bodyBytes": size, "resourceId": resource, "headers": {"dataContext": None},
            "serviceContext": {"clipboardScope": None},
            **({"team": {"permissions": ["applications.manage"]}} if family == "studio" else {})}


class DeploymentPolicyTests(unittest.TestCase):
    def test_enterprise_and_personal_routes_have_exact_authority_and_body_budgets(self):
        for prefix, family, resource in PREFIXES:
            for method, path, action, limit in ROUTES:
                with self.subTest(prefix=prefix, method=method, path=path):
                    result = classify_octop(method, prefix + path, "http", "wanx-host")
                    self.assertEqual(result, {"family": family, "resourceId": resource,
                                              "action": action, "bodyLimit": limit})
                    claims = request_claims(family, resource, action, limit)
                    self.assertEqual(check_octop_request(request_scope(method, prefix + path), claims), result)
                    with self.assertRaises(DataProtocolError):
                        check_octop_request(request_scope(method, prefix + path), dict(claims, bodyBytes=limit + 1))

    def test_deployment_does_not_inherit_head_or_websocket_access(self):
        for prefix, _, _ in PREFIXES:
            for method, path, _, _ in ROUTES:
                with self.subTest(prefix=prefix, method=method, path=path):
                    if method == "GET":
                        with self.assertRaises(DataProtocolError):
                            classify_octop("HEAD", prefix + path, "http", "wanx-host")
                    with self.assertRaises(DataProtocolError):
                        classify_octop(method, prefix + path, "websocket", "wanx-host")

    def test_team_management_permission_remains_mandatory(self):
        prefix, family, resource = PREFIXES[0]
        for method, path, action, _ in ROUTES:
            claims = request_claims(family, resource, action)
            for team in [None, {}, {"permissions": []}, {"permissions": ["resources.manage"]}]:
                with self.subTest(method=method, path=path, team=team), self.assertRaises(DataProtocolError):
                    check_octop_request(request_scope(method, prefix + path), dict(claims, team=team))
            for wrong_resource in ["wanx", "team:application:app.example"]:
                with self.assertRaises(DataProtocolError):
                    check_octop_request(request_scope(method, prefix + path), dict(claims, resourceId=wrong_resource))
            with self.assertRaises(DataProtocolError):
                check_octop_request(request_scope(method, prefix + path), dict(claims, action="write" if action != "write" else "execute"))

    def test_personal_routes_do_not_require_or_confer_team_authority(self):
        prefix, family, resource = PREFIXES[1]
        for method, path, action, _ in ROUTES:
            scope = request_scope(method, prefix + path)
            claims = request_claims(family, resource, action)
            self.assertEqual(check_octop_request(scope, claims)["resourceId"], "wanx")
            for selected in ["team:management", "team:application:app.example", "team:space:shared"]:
                with self.assertRaises(DataProtocolError):
                    classify_octop(method, prefix + path, "http", "wanx-host", selected)
            with self.assertRaises(DataProtocolError):
                check_octop_request(scope, dict(claims, resourceId="team:management", team={"permissions": ["applications.manage"]}))

    def test_application_identity_cannot_gain_deployment_permissions(self):
        for prefix, _, _ in PREFIXES:
            for application_id in ["centaurai.wanx.ai-browser", "ai.wanx.selfmade." + OPERATION, "unknown.app"]:
                with self.subTest(prefix=prefix, app=application_id), self.assertRaises(DataProtocolError):
                    classify_octop("POST", prefix + "/operations", "http", application_id)
        result = classify_octop("POST", PREFIXES[0][0] + "/operations", "http", "ai.wanx.studio")
        self.assertEqual(result["resourceId"], "team:management")
        with self.assertRaises(DataProtocolError):
            classify_octop("POST", PREFIXES[1][0] + "/operations", "http", "ai.wanx.studio")

    def test_private_paths_wrong_methods_and_malformed_ids_are_denied(self):
        paths = ["/recover", "/admin", "/executor", "/operations/" + OPERATION + "/recover",
                 "/operations/" + OPERATION + "/executor", "/operations/" + "A" * 32,
                 "/operations/" + "a" * 31, "/operations/" + "a" * 33,
                 "/operations/dep_" + OPERATION, "/operations/" + OPERATION + "/",
                 "/operations/../capabilities", "/operations/%2e%2e/capabilities", "/capabilities#fragment"]
        for prefix, _, _ in PREFIXES:
            for path in paths:
                for method in ["GET", "POST"]:
                    with self.subTest(prefix=prefix, path=path, method=method), self.assertRaises(DataProtocolError):
                        classify_octop(method, prefix + path, "http", "wanx-host")
            for method, path in [("POST", "/capabilities"), ("GET", "/releases"), ("PUT", "/operations"),
                                  ("DELETE", "/operations/" + OPERATION), ("POST", "/environments?" + TARGET),
                                  ("GET", "/operations/" + OPERATION + "/resume"),
                                  ("POST", "/operations/" + OPERATION + "/events"),
                                  ("GET", "/operations/" + OPERATION + "/receipt/retry")]:
                with self.subTest(method=method, path=path), self.assertRaises(DataProtocolError):
                    classify_octop(method, prefix + path, "http", "wanx-host")

    def test_strict_query_whitelist_matches_api_and_renderer(self):
        paths = ["/capabilities?limit=1", "/operations?boxId=box", "/operations?constructor=x",
                 "/operations?__proto__=x", "/operations?limit=1&limit=2", "/operations?limit=0",
                 "/operations?limit=101", "/operations?limit=01", "/operations?limit=1e2",
                 "/environments", "/environments?" + TARGET + "&boxId=other",
                 "/environments?" + TARGET + "&limit=1", "/environments?" + TARGET.replace("dev", "production"),
                 "/environments?" + TARGET.replace("box_1", "a" * 129),
                 "/environments?" + TARGET.replace("box_1", "_box"),
                 "/environments?" + TARGET.replace("box_1", "box+1"),
                 "/environments?" + TARGET.replace("box_1", "box%31"),
                 "/environments?" + TARGET.replace("box_1", ""),
                 "/operations/" + OPERATION + "?after=1", "/operations/" + OPERATION + "/receipt?limit=1",
                 "/operations/" + OPERATION + "/events?after=0&after=1",
                 "/operations/" + OPERATION + "/events?other=1"]
        paths += ["/operations/" + OPERATION + "/events?after=" + value
                  for value in ["-1", "1.5", "1e2", "01", "", "9007199254740992", "1" * 100]]
        paths += ["/operations/" + OPERATION + "/events?limit=" + value for value in ["0", "101", "01", "", "-1"]]
        for prefix, _, _ in PREFIXES:
            for path in paths:
                with self.subTest(prefix=prefix, path=path), self.assertRaises(DataProtocolError):
                    classify_octop("GET", prefix + path, "http", "wanx-host")
            for path in ["/releases", "/operations", "/operations/" + OPERATION + "/resume", "/operations/" + OPERATION + "/receipt/retry"]:
                with self.assertRaises(DataProtocolError):
                    classify_octop("POST", prefix + path + "?boxId=other", "http", "wanx-host")
            self.assertEqual(classify_octop("GET", prefix + "/environments?" + TARGET.replace("box_1", "a" * 128), "http", "wanx-host")["action"], "read")

    def test_existing_routes_keep_their_query_and_head_behavior(self):
        self.assertEqual(classify_octop("HEAD", "/api/app-studio/context", "http", "wanx-host")["action"], "read")
        self.assertEqual(classify_octop("GET", "/api/_client/workshop/projects?includeDeleted=true", "http", "wanx-host")["family"], "workshop")
        with self.assertRaises(DataProtocolError):
            classify_octop("GET", "/api/app-studio/projects?organizationId=org", "http", "wanx-host")
        with self.assertRaises(DataProtocolError):
            classify_octop("GET", "/api/_client/workshop/projects?boxId=box", "http", "wanx-host")


if __name__ == "__main__":
    unittest.main()
