# test_cors.py — ARDY engine (server.py) の CORS 許可ロジックのテスト
#
# 起動例 (リポジトリ直下から):
#   python tools/ardy-engine/test_cors.py
# モデル・GPU・外部ネットワークは不要 (HTTP 部分は 127.0.0.1 の一時サーバーで検証)
import os
import sys
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

# server.py は import 時に parse_args() で sys.argv を読むため、テスト用の引数を
# 一時的に取り除いてから import する
_ORIG_ARGV = sys.argv
sys.argv = [sys.argv[0]]
try:
    import server
finally:
    sys.argv = _ORIG_ARGV

# 作業フロントエンドの一時 Cloudflare Quick Tunnel オリジン (テスト用フィクスチャ。
# ソース本体にはハードコードせず、環境変数 ARDY_ALLOWED_ORIGINS 経由でのみ許可される)
CLOUDFLARE_ORIGIN = "https://unless-designed-primary-trembl.trycloudflare.com"


class _EnvMixin:
    """ARDY_ALLOWED_ORIGINS を毎テストで独立に扱うためのミックスイン"""

    def setUp(self):
        super().setUp()
        self._saved_allowed_origins = os.environ.get("ARDY_ALLOWED_ORIGINS")
        os.environ.pop("ARDY_ALLOWED_ORIGINS", None)

    def tearDown(self):
        if self._saved_allowed_origins is None:
            os.environ.pop("ARDY_ALLOWED_ORIGINS", None)
        else:
            os.environ["ARDY_ALLOWED_ORIGINS"] = self._saved_allowed_origins
        super().tearDown()


class _FakeHandler:
    """Handler._cors_origin をモデルなしで試すための最小スタブ"""

    def __init__(self, origin=None):
        self.headers = {} if origin is None else {"Origin": origin}


class IsLocalOriginTest(_EnvMixin, unittest.TestCase):
    """既存のローカル/アプリオリジンのサポートが維持されていること"""

    def test_existing_local_origins_still_work(self):
        for origin in (
            "app://bundle",
            "http://localhost",
            "http://localhost:5173",
            "http://127.0.0.1:2337",
            "http://[::1]:2337",
            "file://",
        ):
            with self.subTest(origin=origin):
                self.assertTrue(server._is_local_origin(origin))

    def test_external_and_malformed_origins_are_rejected(self):
        for origin in (
            "",
            "null",
            "https://evil.example.com",
            "http://localhost.evil.example",
            "http://127.0.0.1.nip.io",
            " https://localhost",
            "https://localhost ",
            "http://user:pass@localhost",
            "http://localhost/path",
            "http://localhost/?q=1",
            "http://localhost/#frag",
            "http://localhost:notaport",
            "http:/localhost",
            "localhost:5173",
            "ftp://localhost",
        ):
            with self.subTest(origin=origin):
                self.assertFalse(server._is_local_origin(origin))


class ConfiguredOriginsTest(_EnvMixin, unittest.TestCase):
    """環境変数 ARDY_ALLOWED_ORIGINS の受理/拒否"""

    def test_cloudflare_https_origin_is_accepted(self):
        os.environ["ARDY_ALLOWED_ORIGINS"] = CLOUDFLARE_ORIGIN
        self.assertIn(CLOUDFLARE_ORIGIN, server._configured_origins())
        self.assertEqual(
            server.Handler._cors_origin(_FakeHandler(CLOUDFLARE_ORIGIN)),
            CLOUDFLARE_ORIGIN,
        )

    def test_multiple_comma_separated_origins_with_whitespace(self):
        os.environ["ARDY_ALLOWED_ORIGINS"] = (
            f"  {CLOUDFLARE_ORIGIN} , https://other.example.com  "
        )
        self.assertEqual(
            server._configured_origins(),
            frozenset({CLOUDFLARE_ORIGIN, "https://other.example.com"}),
        )

    def test_unconfigured_external_origin_is_rejected(self):
        os.environ["ARDY_ALLOWED_ORIGINS"] = CLOUDFLARE_ORIGIN
        self.assertEqual(
            server.Handler._cors_origin(_FakeHandler("https://not-configured.example.com")),
            "null",
        )

    def test_invalid_entries_are_ignored_but_valid_ones_kept(self):
        os.environ["ARDY_ALLOWED_ORIGINS"] = ",".join((
            "http://plain.example.com",        # https ではない
            "https://user:pass@example.com",   # 認証情報を含む
            "https://example.com/path",        # パスを含む
            "https://example.com/",            # パス (/) を含む
            "https://example.com?q=1",         # クエリを含む
            "https://example.com#frag",        # フラグメントを含む
            "https://example.com:notaport",    # ポート表記が不正
            "not a url",                       # パース不能
            "",
            CLOUDFLARE_ORIGIN,                 # これは有効
        ))
        self.assertEqual(server._configured_origins(), frozenset({CLOUDFLARE_ORIGIN}))

    def test_no_wildcard_or_star_in_config(self):
        os.environ["ARDY_ALLOWED_ORIGINS"] = "*"
        self.assertEqual(server._configured_origins(), frozenset())

    def test_non_ascii_invalid_entry_does_not_break_logging(self):
        # Windowsのcp1252コンソールでも print が例外を投げないこと (CORS応答を壊さない)
        os.environ["ARDY_ALLOWED_ORIGINS"] = "http://日本語.example.com"
        self.assertEqual(server._configured_origins(), frozenset())

    def test_missing_origin_header_maps_to_null(self):
        self.assertEqual(server.Handler._cors_origin(_FakeHandler()), "null")


class CorsHttpTest(_EnvMixin, unittest.TestCase):
    """実際の HTTP 応答ヘッダで CORS を検証 (モデル未読み込みの /health を使用)"""

    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.httpd.server_address[1]
        cls._thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls._thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def _request(self, method, path, origin=None):
        conn = HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            headers = {"Origin": origin} if origin is not None else {}
            conn.request(method, path, headers=headers)
            res = conn.getresponse()
            body = res.read()
            return res.status, {k.lower(): v for k, v in res.getheaders()}, body
        finally:
            conn.close()

    def _assert_acao(self, headers, expected):
        acac = headers.get("access-control-allow-origin")
        self.assertNotEqual(acac, "*", "Access-Control-Allow-Origin: * は禁止")
        self.assertEqual(acac, expected)
        self.assertEqual(headers.get("vary"), "Origin")

    def test_local_origins_accepted_over_http(self):
        for origin in (
            "app://bundle",
            "http://localhost:5173",
            "http://127.0.0.1:2337",
            "http://[::1]:2337",
        ):
            with self.subTest(origin=origin):
                status, headers, _ = self._request("GET", "/health", origin)
                self.assertEqual(status, 200)
                self._assert_acao(headers, origin)

    def test_configured_cloudflare_origin_accepted_over_http(self):
        os.environ["ARDY_ALLOWED_ORIGINS"] = CLOUDFLARE_ORIGIN
        status, headers, _ = self._request("GET", "/health", CLOUDFLARE_ORIGIN)
        self.assertEqual(status, 200)
        self._assert_acao(headers, CLOUDFLARE_ORIGIN)

    def test_unconfigured_external_origin_rejected_over_http(self):
        os.environ["ARDY_ALLOWED_ORIGINS"] = CLOUDFLARE_ORIGIN
        _, headers, _ = self._request("GET", "/health", "https://not-configured.example.com")
        self.assertEqual(headers.get("access-control-allow-origin"), "null")
        self.assertNotEqual(headers.get("access-control-allow-origin"), "*")

    def test_malformed_origin_rejected_over_http(self):
        _, headers, _ = self._request("GET", "/health", "http://localhost.evil.example")
        self.assertEqual(headers.get("access-control-allow-origin"), "null")

    def test_preflight_allows_frontend_methods_and_headers(self):
        os.environ["ARDY_ALLOWED_ORIGINS"] = CLOUDFLARE_ORIGIN
        status, headers, _ = self._request("OPTIONS", "/generate", CLOUDFLARE_ORIGIN)
        self.assertEqual(status, 204)
        self._assert_acao(headers, CLOUDFLARE_ORIGIN)
        methods = headers.get("access-control-allow-methods", "")
        self.assertIn("GET", methods)
        self.assertIn("POST", methods)
        self.assertIn("Content-Type", headers.get("access-control-allow-headers", ""))

    def test_preflight_rejected_for_unconfigured_origin(self):
        os.environ["ARDY_ALLOWED_ORIGINS"] = CLOUDFLARE_ORIGIN
        _, headers, _ = self._request("OPTIONS", "/generate", "https://evil.example.com")
        self.assertEqual(headers.get("access-control-allow-origin"), "null")
        self.assertNotEqual(headers.get("access-control-allow-origin"), "*")

    def test_post_response_carries_configured_origin(self):
        # モデル未読み込みなら 503 だが、CORS ヘッダは付いている必要がある
        os.environ["ARDY_ALLOWED_ORIGINS"] = CLOUDFLARE_ORIGIN
        status, headers, _ = self._request("POST", "/generate", CLOUDFLARE_ORIGIN)
        self.assertIn(status, (200, 503))
        self._assert_acao(headers, CLOUDFLARE_ORIGIN)


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]] + _ORIG_ARGV[1:])
