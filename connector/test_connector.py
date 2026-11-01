#!/usr/bin/env python3
"""End-to-end tests for tv-connector.py: python3 test_connector.py

Runs the real server on a random local port and talks to it the way Tailscale
Funnel and Claude would (Funnel sets X-Forwarded-For to the caller's address).
"""

import base64
import hashlib
import http.client
import importlib.util
import json
import os
import re
import tempfile
import threading
import unittest
import urllib.parse
from pathlib import Path

TMP = tempfile.mkdtemp(prefix="tvc-test-")
os.environ["HOME"] = TMP
os.environ["XDG_CONFIG_HOME"] = os.path.join(TMP, "config")
os.environ["XDG_STATE_HOME"] = os.path.join(TMP, "state")

spec = importlib.util.spec_from_file_location("tvc", Path(__file__).with_name("tv-connector.py"))
tvc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tvc)

PUBLIC = "https://tv.example-tailnet.ts.net"
CALLBACK = "https://claude.ai/api/mcp/auth_callback"
ANTHROPIC_IP = "160.79.104.25"
OUTSIDER_IP = "203.0.113.9"
CODE = "ABCD-EFGH-JKMN"


def pkce():
    verifier = base64.urlsafe_b64encode(os.urandom(40)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


class ConnectorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        config = {"public_url": PUBLIC, "port": 0, "allowed_networks": tvc.ANTHROPIC_NETWORKS}
        tvc.set_code(config, CODE)
        tvc.write_json_private(tvc.CONFIG_FILE, config)
        cls.config = config
        cls.store = tvc.Store()
        cls.app = tvc.App(config, cls.store)
        cls.server = tvc.Server(("127.0.0.1", 0), tvc.Handler)
        cls.server.app = cls.app
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        self.store.failures.clear()
        self.store.registrations.clear()
        self.fresh_code()

    def fresh_code(self, code=CODE, created=None):
        cfg = tvc.load_config()
        tvc.set_code(cfg, code)
        if created is not None:
            cfg["code_created"] = created
        tvc.write_json_private(tvc.CONFIG_FILE, cfg)

    # ---- helpers ----

    def req(self, method, path, body=None, headers=None, ip=ANTHROPIC_IP):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        h = dict(headers or {})
        if ip:
            h["X-Forwarded-For"] = ip
        if isinstance(body, dict):
            body = json.dumps(body)
            h.setdefault("Content-Type", "application/json")
        conn.request(method, path, body=body, headers=h)
        r = conn.getresponse()
        data = r.read()
        conn.close()
        return r.status, dict(r.getheaders()), data

    def register(self):
        s, _, d = self.req("POST", "/register", {"redirect_uris": [CALLBACK], "client_name": "Claude"})
        self.assertEqual(s, 201, d)
        return json.loads(d)["client_id"]

    def sign_in(self, client_id, code=CODE):
        verifier, challenge = pkce()
        q = urllib.parse.urlencode({
            "response_type": "code", "client_id": client_id, "redirect_uri": CALLBACK,
            "code_challenge": challenge, "code_challenge_method": "S256", "state": "xyz",
            "scope": "tv", "resource": PUBLIC + "/mcp",
        })
        s, _, page = self.req("GET", "/authorize?" + q, ip="198.51.100.7")  # the owner's phone
        self.assertEqual(s, 200)
        request_id = re.search(rb'name="request_id" value="([^"]+)"', page).group(1).decode()
        form = urllib.parse.urlencode({"request_id": request_id, "code": code, "action": "approve"})
        s, h, page = self.req("POST", "/authorize", form, {"Content-Type": "application/x-www-form-urlencoded"}, ip="198.51.100.7")
        return s, h, page, verifier, request_id

    def get_tokens(self, client_id):
        s, h, _, verifier, _ = self.sign_in(client_id)
        self.assertEqual(s, 302)
        loc = urllib.parse.urlsplit(h["Location"])
        self.assertEqual(f"{loc.scheme}://{loc.netloc}{loc.path}", CALLBACK)
        q = dict(urllib.parse.parse_qsl(loc.query))
        self.assertEqual(q["state"], "xyz")
        self.assertEqual(q["iss"], PUBLIC)
        form = urllib.parse.urlencode({
            "grant_type": "authorization_code", "code": q["code"], "client_id": client_id,
            "redirect_uri": CALLBACK, "code_verifier": verifier,
        })
        s, _, d = self.req("POST", "/token", form, {"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual(s, 200, d)
        return json.loads(d), q["code"], verifier

    def rpc(self, token, method, params=None, rid=1):
        msg = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        if rid is not None:
            msg["id"] = rid
        return self.req("POST", "/mcp", msg, {"Authorization": f"Bearer {token}", "Accept": "application/json, text/event-stream"})

    def call(self, token, name, args):
        s, _, d = self.rpc(token, "tools/call", {"name": name, "arguments": args})
        self.assertEqual(s, 200, d)
        return json.loads(d)["result"]

    # ---- discovery ----

    def test_unauthenticated_mcp_gets_401_with_metadata_pointer(self):
        s, h, _ = self.req("POST", "/mcp", {"jsonrpc": "2.0", "id": 1, "method": "initialize"})
        self.assertEqual(s, 401)
        self.assertIn(f'resource_metadata="{PUBLIC}/.well-known/oauth-protected-resource"', h["WWW-Authenticate"])

    def test_metadata(self):
        s, _, d = self.req("GET", "/.well-known/oauth-protected-resource")
        prm = json.loads(d)
        self.assertEqual(prm["resource"], PUBLIC + "/mcp")
        self.assertEqual(prm["authorization_servers"], [PUBLIC])
        s, _, d = self.req("GET", "/.well-known/oauth-protected-resource/mcp")
        self.assertEqual(s, 200)
        s, _, d = self.req("GET", "/.well-known/oauth-authorization-server")
        asm = json.loads(d)
        self.assertEqual(asm["issuer"], PUBLIC)
        self.assertEqual(asm["code_challenge_methods_supported"], ["S256"])
        self.assertEqual(asm["registration_endpoint"], PUBLIC + "/register")
        self.assertIn("none", asm["token_endpoint_auth_methods_supported"])

    # ---- network allowlist ----

    def test_outsiders_and_local_are_blocked(self):
        for ip in (OUTSIDER_IP, None):  # None = no X-Forwarded-For (a local process)
            for path in ("/mcp", "/token", "/register"):
                s, _, _ = self.req("POST", path, {}, ip=ip)
                self.assertEqual(s, 403, (ip, path))

    def test_refused_request_with_body_does_not_poison_connection(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("POST", "/register", body=json.dumps({"x": "y" * 500}),
                     headers={"X-Forwarded-For": OUTSIDER_IP, "Content-Type": "application/json"})
        r = conn.getresponse()
        r.read()
        self.assertEqual(r.status, 403)
        self.assertEqual(r.getheader("Connection"), "close")
        conn.close()
        s, _, _ = self.req("GET", "/health")
        self.assertEqual(s, 200)

    def test_ipv6_and_garbage_forwarded_for_blocked(self):
        for ip in ("2001:db8::1", "not-an-ip", "160.79.112.1"):
            s, _, _ = self.req("POST", "/mcp", {}, ip=ip)
            self.assertEqual(s, 403, ip)

    # ---- registration ----

    def test_register_rejects_other_redirects(self):
        for uris in (["https://evil.example/cb"], [CALLBACK, "https://evil.example/cb"], [], ["http://claude.ai/api/mcp/auth_callback"]):
            s, _, _ = self.req("POST", "/register", {"redirect_uris": uris})
            self.assertEqual(s, 400, uris)

    # ---- authorize ----

    def test_authorize_unknown_client_or_redirect(self):
        _, ch = pkce()
        s, h, _ = self.req("GET", "/authorize?" + urllib.parse.urlencode({
            "response_type": "code", "client_id": "nope", "redirect_uri": CALLBACK,
            "code_challenge": ch, "code_challenge_method": "S256"}))
        self.assertEqual(s, 400)
        cid = self.register()
        s, h, _ = self.req("GET", "/authorize?" + urllib.parse.urlencode({
            "response_type": "code", "client_id": cid, "redirect_uri": "https://evil.example/cb",
            "code_challenge": ch, "code_challenge_method": "S256"}))
        self.assertEqual(s, 400)
        self.assertNotIn("Location", h)

    def test_authorize_requires_s256(self):
        cid = self.register()
        s, h, _ = self.req("GET", "/authorize?" + urllib.parse.urlencode({
            "response_type": "code", "client_id": cid, "redirect_uri": CALLBACK,
            "code_challenge": "x" * 43, "code_challenge_method": "plain", "state": "s"}))
        self.assertEqual(s, 302)
        self.assertIn("error=invalid_request", h["Location"])

    def test_wrong_code_then_global_lockout(self):
        cid = self.register()
        for _ in range(tvc.LOCKOUT_FAILURES):
            s, _, page, _, _ = self.sign_in(cid, code="ZZZZ-ZZZZ-ZZZZ")  # a new sign-in page each time
            self.assertEqual(s, 200)
            self.assertIn(b"isn&#x27;t right", page)
        s, _, page, _, _ = self.sign_in(cid)  # even the right code is refused while locked
        self.assertEqual(s, 200)
        self.assertIn(b"Too many wrong codes", page)

    def post_code(self, request_id, code):
        form = urllib.parse.urlencode({"request_id": request_id, "code": code, "action": "approve"})
        return self.req("POST", "/authorize", form, {"Content-Type": "application/x-www-form-urlencoded"})

    def test_sign_in_page_dies_after_three_wrong_codes(self):
        cid = self.register()
        s, _, _, _, rid = self.sign_in(cid, code="ZZZZ-ZZZZ-ZZZZ")
        self.post_code(rid, "YYYY-YYYY-YYYY")
        s, _, page = self.post_code(rid, "XXXX-XXXX-XXXX")
        self.assertEqual(s, 400)
        s, _, page = self.post_code(rid, CODE)  # page is gone even with the right code
        self.assertEqual(s, 400)
        self.assertIn(b"expired", page)

    def test_parallel_guesses_cannot_pass_lockout(self):
        cid = self.register()
        rids = [self.sign_in(cid, code="ZZZZ-ZZZZ-ZZZZ")[4] for _ in range(1)]
        self.store.failures.clear()
        # 30 parallel pages x 1 guess each
        pages = []
        for _ in range(30):
            verifier, challenge = pkce()
            q = urllib.parse.urlencode({"response_type": "code", "client_id": cid, "redirect_uri": CALLBACK,
                                        "code_challenge": challenge, "code_challenge_method": "S256"})
            _, _, page = self.req("GET", "/authorize?" + q)
            pages.append(re.search(rb'name="request_id" value="([^"]+)"', page).group(1).decode())
        results = []
        threads = [threading.Thread(target=lambda r=r: results.append(self.post_code(r, "WWWW-WWWW-WWWW"))) for r in pages]
        [t.start() for t in threads]
        [t.join() for t in threads]
        checked = sum(1 for _, _, p in results if b"isn&#x27;t right" in p)
        self.assertLessEqual(checked, tvc.LOCKOUT_FAILURES)
        del rids

    def test_code_works_once(self):
        cid = self.register()
        s, _, _, _, _ = self.sign_in(cid)
        self.assertEqual(s, 302)
        s, _, page, _, _ = self.sign_in(cid)
        self.assertEqual(s, 200)
        self.assertIn(b"already used", page)
        self.assertEqual(len(self.store.failures), 0)  # the right-but-used code isn't a guess

    def test_code_expires(self):
        cid = self.register()
        self.fresh_code(created=tvc.now() - tvc.CODE_TTL - 10)
        s, _, page, _, _ = self.sign_in(cid)
        self.assertEqual(s, 200)
        self.assertIn(b"expired", page)

    def test_new_code_takes_effect_without_restart(self):
        cid = self.register()
        self.fresh_code("PQRS-TUVW-XYZ2")
        s, _, page, _, _ = self.sign_in(cid)  # old code
        self.assertEqual(s, 200)
        s, _, _, _, _ = self.sign_in(cid, code="PQRS-TUVW-XYZ2")
        self.assertEqual(s, 302)

    def test_consent_page_warns_about_shared_links(self):
        cid = self.register()
        _, ch = pkce()
        _, _, page = self.req("GET", "/authorize?" + urllib.parse.urlencode({
            "response_type": "code", "client_id": cid, "redirect_uri": CALLBACK,
            "code_challenge": ch, "code_challenge_method": "S256"}))
        self.assertIn(b"If someone sent you this link, choose Deny", page)

    def test_code_is_case_and_dash_insensitive(self):
        cid = self.register()
        s, _, _, _, _ = self.sign_in(cid, code="abcd efgh jkmn")
        self.assertEqual(s, 302)

    def test_deny(self):
        cid = self.register()
        verifier, challenge = pkce()
        q = urllib.parse.urlencode({"response_type": "code", "client_id": cid, "redirect_uri": CALLBACK,
                                    "code_challenge": challenge, "code_challenge_method": "S256", "state": "st"})
        _, _, page = self.req("GET", "/authorize?" + q)
        rid = re.search(rb'name="request_id" value="([^"]+)"', page).group(1).decode()
        s, h, _ = self.req("POST", "/authorize", urllib.parse.urlencode({"request_id": rid, "action": "deny"}),
                           {"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual(s, 302)
        self.assertIn("error=access_denied", h["Location"])
        self.assertIn("state=st", h["Location"])

    def test_authorize_page_has_csp(self):
        cid = self.register()
        _, ch = pkce()
        _, h, _ = self.req("GET", "/authorize?" + urllib.parse.urlencode({
            "response_type": "code", "client_id": cid, "redirect_uri": CALLBACK,
            "code_challenge": ch, "code_challenge_method": "S256"}))
        self.assertIn("frame-ancestors 'none'", h["Content-Security-Policy"])

    # ---- token ----

    def test_pkce_and_single_use_code(self):
        cid = self.register()
        s, h, _, verifier, _ = self.sign_in(cid)
        code = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(h["Location"]).query))["code"]
        bad = urllib.parse.urlencode({"grant_type": "authorization_code", "code": code, "client_id": cid,
                                      "redirect_uri": CALLBACK, "code_verifier": "wrong" * 10})
        s, _, d = self.req("POST", "/token", bad, {"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual((s, json.loads(d)["error"]), (400, "invalid_grant"))
        # a failed attempt burns the code
        good = urllib.parse.urlencode({"grant_type": "authorization_code", "code": code, "client_id": cid,
                                       "redirect_uri": CALLBACK, "code_verifier": verifier})
        s, _, d = self.req("POST", "/token", good, {"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual((s, json.loads(d)["error"]), (400, "invalid_grant"))

    def test_code_bound_to_client(self):
        cid = self.register()
        other = self.register()
        s, h, _, verifier, _ = self.sign_in(cid)
        code = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(h["Location"]).query))["code"]
        form = urllib.parse.urlencode({"grant_type": "authorization_code", "code": code, "client_id": other,
                                       "redirect_uri": CALLBACK, "code_verifier": verifier})
        s, _, d = self.req("POST", "/token", form, {"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual(json.loads(d)["error"], "invalid_grant")

    def test_refresh_replay_signs_client_out(self):
        cid = self.register()
        tokens, _, _ = self.get_tokens(cid)
        form = urllib.parse.urlencode({"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"], "client_id": cid})
        s, _, d = self.req("POST", "/token", form, {"Content-Type": "application/x-www-form-urlencoded"})
        new = json.loads(d)
        # pretend the rotation happened long ago, then replay the old token
        for rec in self.store.used_refresh.values():
            rec["rotated"] -= tvc.REFRESH_REUSE_GRACE + 5
        s, _, d = self.req("POST", "/token", form, {"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual(json.loads(d)["error"], "invalid_grant")
        s, _, _ = self.rpc(new["access_token"], "ping")
        self.assertEqual(s, 401)  # the new tokens were revoked too

    def test_registration_rate_limit_and_live_client_kept(self):
        cid = self.register()
        tokens, _, _ = self.get_tokens(cid)
        for _ in range(tvc.MAX_REGISTRATIONS_PER_HOUR - 1):
            self.register()
        s, _, _ = self.req("POST", "/register", {"redirect_uris": [CALLBACK]})
        self.assertEqual(s, 429)
        # flood past MAX_CLIENTS: the signed-in client survives
        for _ in range(tvc.MAX_CLIENTS + 5):
            self.store.registrations.clear()
            self.register()
        self.assertIn(cid, self.store.clients)
        form = urllib.parse.urlencode({"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"], "client_id": cid})
        s, _, _ = self.req("POST", "/token", form, {"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual(s, 200)

    def test_chunked_body_rejected(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("POST", "/mcp", body=iter([b'{"x":1}']), headers={"X-Forwarded-For": ANTHROPIC_IP},
                     encode_chunked=True)
        r = conn.getresponse()
        self.assertEqual(r.status, 501)
        self.assertEqual(r.getheader("Connection"), "close")
        conn.close()

    def test_log_escaping(self):
        self.assertEqual(tvc.safe("a\nowner approved"), "a\\nowner approved")
        self.assertNotIn("\n", tvc.safe("x\ny"))

    def test_refresh_rotation(self):
        cid = self.register()
        tokens, _, _ = self.get_tokens(cid)
        form = urllib.parse.urlencode({"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"], "client_id": cid})
        s, _, d = self.req("POST", "/token", form, {"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual(s, 200)
        new = json.loads(d)
        self.assertNotEqual(new["refresh_token"], tokens["refresh_token"])
        s, _, d = self.req("POST", "/token", form, {"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual((s, json.loads(d)["error"]), (400, "invalid_grant"))
        s, _, _ = self.rpc(new["access_token"], "ping")
        self.assertEqual(s, 200)

    def test_tokens_stored_hashed(self):
        cid = self.register()
        tokens, _, _ = self.get_tokens(cid)
        raw = Path(tvc.STATE_FILE).read_text()
        self.assertNotIn(tokens["access_token"], raw)
        self.assertNotIn(tokens["refresh_token"], raw)
        self.assertEqual(os.stat(tvc.STATE_FILE).st_mode & 0o777, 0o600)

    # ---- MCP ----

    def test_mcp_flow(self):
        cid = self.register()
        tokens, _, _ = self.get_tokens(cid)
        t = tokens["access_token"]
        s, _, d = self.rpc(t, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test"}})
        init = json.loads(d)["result"]
        self.assertEqual(init["protocolVersion"], "2025-06-18")
        self.assertIn("tools", init["capabilities"])
        s, _, _ = self.rpc(t, "notifications/initialized", rid=None)
        self.assertEqual(s, 202)
        s, _, d = self.rpc(t, "tools/list")
        names = {tool["name"] for tool in json.loads(d)["result"]["tools"]}
        self.assertEqual(names, {"run_command", "start_background_job", "job_status", "stop_job", "read_file", "write_file", "system_status"})

        r = self.call(t, "run_command", {"command": "echo hello; echo oops >&2; exit 3"})
        self.assertTrue(r["isError"])
        self.assertIn("exit code 3", r["content"][0]["text"])
        self.assertIn("hello", r["content"][0]["text"])
        self.assertIn("oops", r["content"][0]["text"])

        r = self.call(t, "run_command", {"command": "sleep 5", "timeout_seconds": 1})
        self.assertIn("timed out", r["content"][0]["text"])

        r = self.call(t, "write_file", {"path": "~/notes/a.txt", "content": "line1\n"})
        self.assertFalse(r["isError"], r)
        self.call(t, "write_file", {"path": "~/notes/a.txt", "content": "line2\n", "mode": "append"})
        r = self.call(t, "read_file", {"path": "~/notes/a.txt"})
        self.assertIn("line1\nline2\n", r["content"][0]["text"])
        r = self.call(t, "read_file", {"path": "~/notes/a.txt", "offset": 2, "max_bytes": 3})
        self.assertIn("more remains", r["content"][0]["text"])
        r = self.call(t, "read_file", {"path": "/nonexistent/x"})
        self.assertTrue(r["isError"])

        r = self.call(t, "system_status", {})
        self.assertIn("TV connector", r["content"][0]["text"])

        s, _, d = self.rpc(t, "tools/call", {"name": "nope", "arguments": {}})
        self.assertIn("error", json.loads(d))
        s, _, d = self.rpc(t, "bogus/method")
        self.assertEqual(json.loads(d)["error"]["code"], -32601)

    def test_bad_token_and_bad_origin(self):
        s, _, _ = self.rpc("not-a-token", "ping")
        self.assertEqual(s, 401)
        cid = self.register()
        tokens, _, _ = self.get_tokens(cid)
        s, _, _ = self.req("POST", "/mcp", {"jsonrpc": "2.0", "id": 1, "method": "ping"},
                           {"Authorization": f"Bearer {tokens['access_token']}", "Origin": "https://evil.example"})
        self.assertEqual(s, 403)

    def test_get_mcp_not_allowed(self):
        cid = self.register()
        tokens, _, _ = self.get_tokens(cid)
        s, _, _ = self.req("GET", "/mcp", headers={"Authorization": f"Bearer {tokens['access_token']}"})
        self.assertEqual(s, 405)


if __name__ == "__main__":
    unittest.main(verbosity=1)
