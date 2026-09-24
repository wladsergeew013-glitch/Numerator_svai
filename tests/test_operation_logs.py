import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app import cad_operations as cad, main as api
from fastapi import HTTPException


class OperationLogTests(unittest.TestCase):
    def setUp(self):
        self.clock = 100.0
        self.patches = [patch.object(cad.time, 'monotonic', side_effect=lambda: self.clock),
                        patch.object(cad.sys, 'platform', 'test'), patch.object(cad, 'log_event', None)]
        for item in self.patches:
            item.start()
        self.addCleanup(lambda: [item.stop() for item in reversed(self.patches)])
        self.ids = []
        self.addCleanup(lambda: [cad._jobs.pop(key, None) for key in self.ids])

    def job(self, id):
        self.ids.append(id)
        result = {'id': id, 'kind': 'modelstudio/export', 'status': 'running'}
        cad._jobs[id] = result
        return result

    def test_elapsed_freezes_and_log_contains_result_without_point_payload(self):
        job = self.job('log-success')
        def operation():
            self.clock = 104.25
            cad.progress('Запись номеров', 3, 3, updated=3)
            return {'updated': 3, 'points': [{'private': 'large payload'}]}
        cad._execute(job, operation, (), {})
        job['status'] = 'completed'
        self.clock = 9000
        self.assertEqual(cad.status(job['id'])['elapsedSeconds'], 4.25)
        self.assertNotIn('_logs', cad.status(job['id']))
        log = api.get_cad_operation_logs(job['id'])
        self.assertEqual(log['entries'][0]['event'], 'cad_started')
        self.assertEqual(log['entries'][-1]['event'], 'cad_completed')
        self.assertIn('"updated": 3', log['entries'][-1]['details'])
        self.assertNotIn('large payload', str(log))

    def test_failure_log_and_elapsed_survive_exception(self):
        job = self.job('log-failure')
        def operation():
            self.clock = 102.5
            raise HTTPException(503, 'RPC unavailable')
        with self.assertRaises(HTTPException):
            cad._execute(job, operation, (), {})
        self.clock = 9000
        self.assertEqual(cad.status(job['id'])['elapsedSeconds'], 2.5)
        self.assertEqual(cad.logs(job['id'])['entries'][-1]['event'], 'cad_failed')
        self.assertIn('RPC unavailable', cad.logs(job['id'])['entries'][-1]['details'])

    def test_logs_are_isolated_bounded_and_keep_final_result(self):
        first, second = self.job('log-one'), self.job('log-two')
        def operation():
            for index in range(20):
                cad.emit('write', index=index)
            return {'updated': 20}
        with patch.object(cad, 'MAX_LOG_ENTRIES', 5):
            cad._execute(first, operation, (), {})
        cad._execute(second, lambda: {'updated': 0}, (), {})
        log = cad.logs(first['id'])
        self.assertEqual(len(log['entries']), 5)
        self.assertGreater(log['droppedEntries'], 0)
        self.assertEqual(log['entries'][0]['event'], 'cad_started')
        self.assertEqual(log['entries'][-1]['event'], 'cad_completed')
        self.assertNotIn('"index"', str(cad.logs(second['id'])))
        with self.assertRaises(HTTPException):
            cad.logs('missing-operation')

    def test_detailed_backend_errors_are_in_operation_log(self):
        job = self.job('log-detail')
        def operation():
            with patch.object(api, '_get_backend_logger'):
                api._log_backend_error('write_failed', ValueError('parameter read only'), {'handle': 'ABC'})
            return {}
        cad._execute(job, operation, (), {})
        entry = next(e for e in cad.logs(job['id'])['entries'] if e['event'] == 'write_failed')
        self.assertIn('parameter read only', entry['details'])
        self.assertIn('ABC', entry['details'])

    def test_cancel_running_job_stops_before_next_object(self):
        entered = threading.Event()
        resume = threading.Event()
        processed = []
        def operation():
            entered.set()
            resume.wait(2)
            for index in range(3):
                cad.check_cancelled()
                processed.append(index)
            return {'updated': len(processed)}
        job_id = cad.start('modelstudio/export', operation)['id']
        self.ids.append(job_id)
        try:
            self.assertTrue(entered.wait(2))
            self.assertTrue(api.cancel_cad_operation(job_id)['cancelRequested'])
        finally:
            resume.set()
        for _ in range(100):
            if cad.status(job_id)['status'] != 'running':
                break
            time.sleep(0.01)
        self.assertEqual(cad.status(job_id)['status'], 'cancelled')
        self.assertEqual(processed, [])
        self.assertIn('cad_cancel_requested', [entry['event'] for entry in cad.logs(job_id)['entries']])
        self.assertIn('cad_cancelled', [entry['event'] for entry in cad.logs(job_id)['entries']])


if __name__ == '__main__':
    unittest.main()
