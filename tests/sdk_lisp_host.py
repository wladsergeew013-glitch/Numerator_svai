"""Small AutoLISP host simulator for executing the generated transport program.

The simulated loader and CAD command deliberately clear PICKFIRST, as reported
by the live host. Object geometry and parameter APIs are outside this simulator.
"""
import json
import re
from pathlib import Path


class Symbol(str):
    pass


class Environment(dict):
    def __init__(self, parent=None):
        super().__init__()
        self.parent = parent

    def owner(self, name):
        if name in self or self.parent is None:
            return self
        return self.parent.owner(name)


def parse(program):
    tokens = iter(re.findall(r'"(?:\\.|[^"\\])*"|[()]|[^\s()]+', program))

    def expression(token):
        if token == '(':
            result = []
            for item in tokens:
                if item == ')':
                    return result
                result.append(expression(item))
            raise AssertionError('Unclosed Lisp expression')
        if token.startswith('"'):
            return json.loads(token)
        if re.fullmatch(r'-?\d+', token):
            return int(token)
        return Symbol(token.lower())

    return expression(next(tokens))


class LispHost:
    def __init__(self, handles, *, native_error=False, consume_implied=False):
        self.selection = list(handles)
        self.native_error = native_error
        self.consume_implied = consume_implied
        self.events = []
        self.request_count = 0

    def send(self, program):
        def implied(mode):
            selected = list(self.selection) or None
            if self.consume_implied:
                self.selection = []
            return selected

        def open_file(path, mode):
            self.events.append(('open', Path(path).suffix))
            return open(path, mode, encoding='ascii')

        def load(*_):
            self.events.append(('load', tuple(self.selection)))
            self.selection = []

        def command(name, path):
            self.events.append(('command', tuple(self.selection)))
            self.selection = []
            self.request_count += 1
            request = Path(path)
            fields = {key: bytes.fromhex(value).decode('utf-8') for key, value in
                      (line.split('=', 1) for line in request.read_text().splitlines())}
            handles = []
            if fields.get('scope') == 'selection':
                lines = Path(path + '.selection').read_text().splitlines()
                assert lines[0] == 'PILESDK_SELECTION_1'
                handles = lines[2:]
                assert int(lines[1]) == len(handles)
            payload = {'protocol': 1, 'ok': not self.native_error, 'error': 'Native test error',
                       'module': fields['module'], 'document': fields['document'],
                       'selectionSource': 'pre-command', 'selectionSnapshotCount': len(handles),
                       'objects': [{'handle': item} for item in handles]}
            Path(path + '.response.json').write_text(json.dumps(payload))

        def restore(_, selected):
            self.selection = list(selected or [])
            self.events.append(('restore', tuple(self.selection)))

        def write_line(text, stream):
            stream.write(text + '\n')

        environment = Environment()
        environment.update({
            'nil': None, 'ssget': implied,
            'open': open_file, 'write-line': write_line, 'close': lambda stream: stream.close(),
            'sslength': len, 'ssname': lambda items, index: items[index],
            'entget': lambda handle: {5: handle}, 'assoc': lambda key, data: (key, data[key]),
            'cdr': lambda pair: pair[1], 'itoa': str, '1+': lambda value: value + 1,
            'strcat': lambda *values: ''.join(values),
            'arxload': load, 'command': command, 'sssetfirst': restore, 'princ': lambda: None,
        })

        def evaluate(node, env):
            if isinstance(node, Symbol):
                return env.owner(node)[node]
            if not isinstance(node, list):
                return node
            head, *tail = node
            if head == 'setq':
                for name, value in zip(tail[::2], tail[1::2]):
                    result = evaluate(value, env)
                    env.owner(name)[name] = result
                return result
            if head == 'progn':
                result = None
                for item in tail:
                    result = evaluate(item, env)
                return result
            if head == 'if':
                branch = tail[1] if evaluate(tail[0], env) is not None else tail[2] if len(tail) > 2 else None
                return evaluate(branch, env)
            if head == 'repeat':
                for _ in range(evaluate(tail[0], env)):
                    for body in tail[1:]:
                        evaluate(body, env)
                return None
            if head == 'lambda':
                def invoke(*args):
                    local = Environment(env)
                    parameters = tail[0]
                    split = parameters.index('/') if '/' in parameters else len(parameters)
                    local.update(zip(parameters[:split], args))
                    local.update((name, None) for name in parameters[split + 1:])
                    for body in tail[1:]:
                        result = evaluate(body, local)
                    return result
                return invoke
            return evaluate(head, env)(*(evaluate(item, env) for item in tail))

        evaluate(parse(program), environment)
