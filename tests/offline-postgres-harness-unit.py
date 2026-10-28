"""Harness safety checks at the subprocess boundary; never contact Docker."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('offline_pg',ROOT/'scripts/test-offline-postgres.py')
assert spec is not None and spec.loader is not None
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class HarnessSafety(unittest.TestCase):
    def test_context_precedence_is_resolved_then_endpoint_and_env_are_pinned(self):
        with patch.dict(os.environ,{'DOCKER_HOST':'tcp://never.invalid:2376','DOCKER_CONTEXT':'local-test','DOCKER_TLS_VERIFY':'1'}), patch.object(module.subprocess,'check_output',return_value='unix:///fixture/socket\n') as check:
            cmd,env=module.local_docker()
        self.assertEqual(cmd,['docker','--host','unix:///fixture/socket'])
        self.assertEqual(check.call_args.args[0],['docker','context','inspect','--format','{{.Endpoints.docker.Host}}'])
        self.assertTrue(all(k not in env for k in module.SELECTION))

    def test_remote_context_is_rejected_before_daemon_subprocess(self):
        with patch.object(module.subprocess,'check_output',return_value='tcp://never.invalid:2376'),patch.object(module.subprocess,'run') as run:
            with self.assertRaisesRegex(RuntimeError,'non-local'):module.local_docker()
            run.assert_not_called()

    def test_failed_launch_attempt_still_removes_exact_run_and_reads_absence(self):
        self.run_failure(log_failure=False)

    def test_log_failure_cannot_skip_scoped_removal(self):
        self.run_failure(log_failure=True)

    def run_failure(self,log_failure):
        # Fresh CI runners do not have the agent's scratch parent yet.
        module.SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='offline-pg-unit-',dir=module.SCRATCH) as directory:
            commands=[]
            def fake(command,**kwargs):
                commands.append(command)
                self.assertEqual(command[:3],['docker','--host','unix:///fixture/socket'])
                self.assertTrue(all(k not in kwargs['env'] for k in module.SELECTION))
                args=command[3:]
                if args[0]=='run':
                    self.assertIn('--pull=never',args);self.assertEqual(args[args.index('--network')+1],'none')
                    self.assertNotIn('-p',args);self.assertIn('listen_addresses=',args)
                    self.assertTrue(any('source='+str(module.SCRATCH) in a for a in args))
                    return subprocess.CompletedProcess(command,1,'created-but-cli-failed','launch failure')
                return subprocess.CompletedProcess(command,0,'','')
            original=Path.open
            def open_path(path,*args,**kwargs):
                if log_failure and path.name=='postgres.log' and any(c[3]=='run' for c in commands):raise OSError('fixture log unavailable')
                return original(path,*args,**kwargs)
            with patch.object(module.subprocess,'check_output',return_value='unix:///fixture/socket'),patch.object(module.subprocess,'run',side_effect=fake),patch('sys.argv',['test-offline-postgres.py','--log-dir',directory]),patch.object(Path,'open',open_path):
                with self.assertRaises((OSError,subprocess.CalledProcessError)):module.main()
            launched=next(c for c in commands if c[3]=='run')
            name=launched[launched.index('--name')+1]
            self.assertTrue(name.startswith('kotonoha-offline-'))
            self.assertTrue(any(c[3:]==['rm','--force',name] for c in commands))
            self.assertTrue(any(c[3:]==['container','ls','--all','--filter',f'name=^/{name}$','--format','{{.Names}}'] for c in commands))

if __name__=='__main__':unittest.main()
