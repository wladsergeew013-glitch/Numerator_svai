"""Local browser boundary, session credentials and pre-parser resource limits.

Protects against websites/LAN access, not arbitrary code already running as the
same OS user. Native pywebview file dialogs remain outside the HTTP interface.
"""
import hmac
import secrets
import os
import ipaddress
from urllib.parse import urlsplit
from http.cookies import SimpleCookie
from starlette.responses import JSONResponse
from app.project_limits import MAX_PROJECT_JSON_BYTES

SESSION_TOKEN = secrets.token_urlsafe(32)
# Cookies are scoped by host, not port. Separate local app processes must not
# overwrite each other's passive-image credential on the same loopback host.
SESSION_COOKIE = 'pile_session_' + secrets.token_hex(8)
DEV_ORIGINS = {'http://localhost:5173', 'http://127.0.0.1:5173'}
MAX_BODY = 16_200_000
PROJECT_BODY_PATHS = {'/api/projects/local/save', '/api/projects/validate', '/api/autosave/project'}


class LocalApiBoundary:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        headers = {k.decode('latin1').lower(): v.decode('latin1') for k, v in scope['headers']}
        cors_headers = {}

        async def reject(code, message):
            await JSONResponse({'detail': message}, status_code=code, headers=cors_headers)(scope, receive, send)
        try:
            peer = ipaddress.ip_address(scope.get('client', ('', 0))[0])
            permitted_peer = peer.is_loopback or (os.environ.get('PILE_NUMBERING_TRUST_CONTAINER_PEERS') == '1' and peer.is_private)
        except (ValueError, TypeError): permitted_peer = False
        if not permitted_peer: return await reject(403, 'A local client connection is required')
        for name in (b'host', b'origin', b'x-pile-token', b'content-length'):
            if sum(k.lower() == name for k, _ in scope['headers']) > 1:
                return await reject(400, 'Duplicate security header')
        if sum(len(k) + len(v) for k, v in scope['headers']) > 16384 or any(len(v) > 8192 for _, v in scope['headers']):
            return await reject(431, 'Request headers are too large')
        host = headers.get('host', '')
        try:
            parsed = urlsplit('http://' + host)
            valid_host = parsed.hostname in {'localhost', '127.0.0.1', '::1'} and parsed.username is None and parsed.path == '' and not parsed.query and not parsed.fragment
            parsed.port  # Reject a malformed/out-of-range port.
        except ValueError:
            valid_host = False
        if not valid_host:
            return await reject(400, 'Invalid local Host')
        path = scope.get('path', '')
        if '\\' in path or path.startswith('//') or '\x00' in path:
            return await reject(400, 'Invalid path')
        if len(headers.get('range', '')) > 512 or headers.get('range', '').count(',') > 16:
            return await reject(416, 'Too many byte ranges')
        if path.startswith('/api') or path in {'/docs', '/redoc', '/openapi.json'}:
            allowed = {f"{scope.get('scheme', 'http')}://{host}", *DEV_ORIGINS}
            origin = headers.get('origin')
            referer = headers.get('referer')
            if origin is not None and origin not in allowed:
                return await reject(403, 'Origin is not allowed')
            if not origin and referer:
                ref = urlsplit(referer)
                if f'{ref.scheme}://{ref.netloc}' not in allowed:
                    return await reject(403, 'Referer is not allowed')
            if headers.get('sec-fetch-site') == 'cross-site':
                return await reject(403, 'Cross-site request is not allowed')
            if origin:
                cors_headers = {'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', 'Vary': 'Origin'}
            if scope['method'] == 'OPTIONS':
                if origin not in allowed:
                    return await reject(403, 'Origin is required')
                await JSONResponse({}, headers={**cors_headers, 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type,X-Pile-Client,X-Pile-Token'})(scope, receive, send)
                return
            if path == '/api/session':
                if scope['method'] != 'POST' or headers.get('x-pile-client') != '1':
                    return await reject(403, 'Explicit local client handshake is required')
                response = JSONResponse({'token': SESSION_TOKEN}, headers={'Cache-Control': 'no-store'})
                response.set_cookie(SESSION_COOKIE, SESSION_TOKEN, httponly=True, samesite='strict', path='/api')
                response.headers.update(cors_headers)
                return await response(scope, receive, send)
            cookie = SimpleCookie()
            try: cookie.load(headers.get('cookie', ''))
            except Exception: pass
            # Cookie credentials are only for passive image reads. Even a
            # no-referrer request from another localhost port cannot invoke a
            # privileged GET using an ambient cookie.
            image_read = path.startswith('/api/assets/icons/') and scope['method'] in ('GET', 'HEAD')
            token = headers.get('x-pile-token', '') or (cookie[SESSION_COOKIE].value if image_read and SESSION_COOKIE in cookie else '')
            if not hmac.compare_digest(token.encode('utf-8'), SESSION_TOKEN.encode('ascii')):
                return await reject(401, 'Local session credential is required')
        limit = MAX_BODY
        if path in {'/api/config/app-icon', '/api/assets/icons'}:
            limit = 2_100_000
        elif scope['method'] == 'POST' and path in PROJECT_BODY_PATHS:
            limit = MAX_PROJECT_JSON_BYTES + 4_000_000
        try:
            length = int(headers.get('content-length', '0'))
            if length < 0: raise ValueError()
        except ValueError:
            return await reject(400, 'Invalid Content-Length')
        if length > limit:
            return await reject(413, 'Request body is too large')
        if path.startswith('/api') and headers.get('content-type', '').split(';')[0] == 'application/x-www-form-urlencoded':
            return await reject(415, 'Use JSON or multipart/form-data')
        chunks, size = [], 0
        while True:
            message = await receive()
            if message['type'] == 'http.disconnect': return
            body = message.get('body', b''); size += len(body)
            if size > limit: return await reject(413, 'Request body is too large')
            chunks.append(body)
            if not message.get('more_body', False): break
        position = 0
        async def replay():
            nonlocal position
            if position >= len(chunks): return await receive()
            body = chunks[position]; position += 1
            return {'type': 'http.request', 'body': body, 'more_body': position < len(chunks)}
        async def cors_send(message):
            if message['type'] == 'http.response.start' and cors_headers:
                message['headers'] = list(message.get('headers', [])) + [(key.lower().encode('ascii'), value.encode('ascii')) for key, value in cors_headers.items()]
            await send(message)
        await self.app(scope, replay, cors_send)
