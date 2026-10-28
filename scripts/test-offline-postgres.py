#!/usr/bin/env python3
"""Local-only PostgreSQL: installed image, no network/ports/secrets, pinned Unix daemon.

Logs/commands and DB bind mount stay in Hermes scratch. Only this run's random
container may be removed; daemon failure never counts as verified cleanup.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
SCRATCH = Path.home() / '.hermes/cache/scratch'
SELECTION = ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH')


def local_docker():
    # Docker resolves CONTEXT/HOST precedence; metadata-only, before daemon I/O.
    endpoint = subprocess.check_output(['docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], text=True).strip()
    if not endpoint.startswith('unix:///') or '?' in endpoint or '#' in endpoint or '\n' in endpoint:
        raise RuntimeError('refusing non-local Docker endpoint')
    env = os.environ.copy()
    for key in SELECTION:
        env.pop(key, None)
    return ['docker', '--host', endpoint], env


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--log-dir', type=Path)
    parser.add_argument('--sql', default='tests/offline-upload-database.sql')
    args = parser.parse_args()
    SCRATCH.mkdir(parents=True, exist_ok=True)
    run_dir = Path(tempfile.mkdtemp(prefix='kotonoha-offline-pg-', dir=SCRATCH))
    log_dir = (args.log_dir or run_dir).resolve()
    if not log_dir.is_relative_to(SCRATCH.resolve()):
        raise ValueError('logs must stay in Hermes scratch')
    log_dir.mkdir(parents=True, exist_ok=True)
    test_path = (ROOT / args.sql).resolve()
    if not test_path.is_relative_to(ROOT / 'tests'):
        raise ValueError('SQL tests must be in repository tests/')
    name = 'kotonoha-offline-' + uuid.uuid4().hex[:12]
    cmd, env = local_docker()
    commands = []
    launch_attempted = False
    removed = False

    def run(args, text=None, check=True):
        command = cmd + args
        commands.append(command)
        r = subprocess.run(command, input=text, text=True, capture_output=True, env=env, timeout=90)
        with (log_dir / 'postgres.log').open('a') as log:
            log.write('$ ' + ' '.join(command) + '\n' + r.stdout + r.stderr)
        if check and r.returncode:
            print(r.stdout + r.stderr, flush=True)
            r.check_returncode()
        return r

    def sql(text):
        return run(['exec', '-i', name, 'psql', '-X', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], text).stdout

    def worker(text, label):
        command = cmd + ['exec', '-i', name, 'psql', '-X', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At']
        commands.append(command)
        p = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        assert p.stdin is not None
        p.stdin.write("set application_name='" + label + "';\n" + text + '\n')
        p.stdin.flush()
        return p

    def wait_lock(label):
        for _ in range(100):
            if sql("select count(*) from pg_stat_activity where application_name='" + label + "' and wait_event_type='Lock';").strip() == '1':
                return
            time.sleep(.05)
        raise RuntimeError('worker never reached lock: ' + label)

    try:
        run(['image', 'inspect', 'postgres:17'])
        (run_dir / 'data').mkdir()
        launch_attempted = True
        run(['run', '--pull=never', '--detach', '--name', name, '--network', 'none', '--mount',
             f'type=bind,source={run_dir / "data"},target=/var/lib/postgresql/data', '-e',
             'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17', 'postgres', '-c', 'listen_addresses='])
        for _ in range(100):
            if ('PostgreSQL init process complete' in run(['logs', name], check=False).stdout and
                    run(['exec', name, 'pg_isready', '-U', 'postgres'], check=False).returncode == 0):
                break
            time.sleep(.1)
        else:
            raise RuntimeError('readiness failed')
        # Only platform prerequisites are stubbed. All kotonoha upload/auth/bot RPCs are real.
        sql('create role anon; create role authenticated; create role service_role; create schema storage; '
            'create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); '
            'create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz); '
            'create table auth.identities(user_id uuid,provider text); create schema extensions; '
            'create extension pgcrypto with schema extensions;')
        migrations = [
            '20260923000100_create_kotonoha_isolated_workspace.sql', '20260923000200_shared_workspace_login.sql',
            '20260923000300_kotonoha_chunked_uploads.sql', '20260923000400_kotonoha_attachments.sql',
            '20260923000500_kotonoha_calendar.sql', '20260924000100_kotonoha_gemini_transcription.sql',
            '20260924000200_kotonoha_gpt_transcribe.sql', '20260924000300_kotonoha_gemini_throttle.sql',
            '20260924000400_kotonoha_api_usage.sql', '20260924000500_kotonoha_gpt_6_luna.sql',
            '20260925000100_kotonoha_attachments_storage_only.sql', '20260930000100_kotonoha_background_tick.sql',
            '20260930000200_kotonoha_meet_bot.sql', '20261004000100_kotonoha_google_members.sql',
            '20261022093000_kotonoha_attachment_images.sql',
        ]
        for filename in migrations:
            print('Applying ' + filename, flush=True)
            sql((ROOT / 'supabase/migrations' / filename).read_text())
        # Snapshot definitions + ACLs and representative legacy rows BEFORE additive DDL.
        sql("create table public.offline_before_rpc as select p.oid,pg_get_functiondef(p.oid) def,p.proacl::text acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','kotonoha');"
            "insert into kotonoha.meetings(id,owner_id,document) values ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','{\"id\":\"legacy\",\"status\":\"done\",\"calendarOverrides\":{},\"attachments\":[],\"sources\":[]}');"
            'create table public.offline_before_rows as select * from kotonoha.meetings;')
        sql((ROOT / 'supabase/migrations/20261028000100_kotonoha_resumable_upload.sql').read_text())
        sql("do $$ begin if exists(select 1 from public.offline_before_rpc b join pg_proc p on p.oid=b.oid where b.def<>pg_get_functiondef(p.oid) or b.acl is distinct from p.proacl::text) then raise exception 'legacy RPC changed'; end if; if exists(select * from public.offline_before_rows except select * from kotonoha.meetings) then raise exception 'legacy row changed'; end if; end $$;")
        for filename in dict.fromkeys(['tests/cloud-upload-database.sql','tests/cloud-attachments-database.sql','tests/offline-upload-database.sql','tests/offline-upload-safety.sql', args.sql]):
            print('Executing ' + filename, flush=True)
            sql((ROOT / filename).read_text())
        # Real roles, not only ACL introspection.
        for role in ['anon', 'authenticated']:
            sql(f"set role {role}; do $$ begin begin perform public.kotonoha_resumable_upload('context',gen_random_uuid(),null); raise exception 'client RPC allowed'; exception when insufficient_privilege then null; end; end $$; reset role;")
        # Competing first creates: no parent exists, so advisory serialization is required.
        owner = '20000000-0000-4000-8000-000000000001'
        ident = '20000000-0000-4000-8000-000000000002'
        part = {'name':'recording-1-1.wav','size':3,'sourceIndex':0,'partNumber':1,'duration':1,'sha256':'b'*64}
        sources = [{'name':'fixture.wav','size':3}]
        doc = {'id':ident, 'status':'uploading','isDemo':False,'sources':sources, 'transcript':'',
               'uploadInput':{'uploadId':ident,'metadata':{'title':'race'},'sources':sources,'parts':[part],'transcript':'','attachments':[]},
               'uploadIdentity':{'uploadId':ident,'ownerId':owner,'planDigest':'a'*64},'audioParts':[],'uploadPlan':[part],'attachmentPlan':[],'attachments':[]}
        payload = json.dumps({'document':doc}).replace("'", "''")
        create = f"set role service_role; select public.kotonoha_resumable_upload('create','{owner}','{ident}','{payload}'::jsonb);"
        holder = worker(f"begin; select pg_advisory_xact_lock(hashtextextended('{owner}',1477));", 'offline-holder')
        # Use lock ownership readback as a barrier, never sleep to guess scheduling.
        for _ in range(100):
            if sql("select count(*) from pg_locks l join pg_stat_activity a using(pid) where a.application_name='offline-holder' and l.locktype='advisory' and l.granted;").strip() == '1': break
            time.sleep(.05)
        else: raise RuntimeError('holder not armed')
        workers = [worker(create, f'offline-create-{n}') for n in range(2)]
        for n in range(2): wait_lock(f'offline-create-{n}')
        assert holder.stdin is not None
        holder.stdin.write('commit;\n'); holder.stdin.flush()
        for n,p in enumerate([holder]+workers):
            out,err=p.communicate(timeout=30)
            (log_dir/f'create-worker-{n}.log').write_text(out+err)
            if p.returncode: raise RuntimeError(out+err)
        assert sql(f"select count(*) from kotonoha.meetings where id='{ident}';").strip() == '1'
        # Competing same-index appends must preserve exactly one storage path.
        holder=worker(f"begin; select id from kotonoha.meetings where id='{ident}' for update;",'offline-append-holder')
        for _ in range(100):
            if sql("select count(*) from pg_stat_activity where application_name='offline-append-holder' and state='idle in transaction';").strip()=='1': break
            time.sleep(.05)
        else: raise RuntimeError('append holder not armed')
        workers=[]
        for n in range(2):
            data=json.dumps({'index':0,'part':{**part,'audioPath':f'{owner}/{ident}/candidate-{n}'}})
            workers.append(worker(f"set role service_role; select public.kotonoha_resumable_upload('append','{owner}','{ident}','{data}');",f'offline-append-{n}'))
        for n in range(2): wait_lock(f'offline-append-{n}')
        assert holder.stdin is not None
        holder.stdin.write('commit;\n');holder.stdin.flush()
        results=[]
        for n,p in enumerate([holder]+workers):
            out,err=p.communicate(timeout=30)
            (log_dir/f'append-worker-{n}.log').write_text(out+err)
            if p.returncode:raise RuntimeError(out+err)
            if n:results.append(next(json.loads(line) for line in out.splitlines() if line.startswith('{')))
        assert results[0]==results[1] and len(results[0]['document']['audioParts'])==1
        # Two completions blocked behind an exact parent row, one immutable receipt/runId.
        holder=worker(f"begin; select id from kotonoha.meetings where id='{ident}' for update;",'offline-row-holder')
        for _ in range(100):
            if sql("select count(*) from pg_stat_activity where application_name='offline-row-holder' and state='idle in transaction';").strip()=='1': break
            time.sleep(.05)
        else: raise RuntimeError('row holder not armed')
        workers=[worker(f"set role service_role; select public.kotonoha_resumable_upload('complete','{owner}','{ident}','{{\"runId\":\"race-{n}\"}}');",f'offline-complete-{n}') for n in range(2)]
        for n in range(2): wait_lock(f'offline-complete-{n}')
        assert holder.stdin is not None
        holder.stdin.write('commit;\n'); holder.stdin.flush()
        results=[]
        for n,p in enumerate([holder]+workers):
            out,err=p.communicate(timeout=30)
            (log_dir/f'complete-worker-{n}.log').write_text(out+err)
            if p.returncode: raise RuntimeError(out+err)
            if n: results.append(next(json.loads(line) for line in out.splitlines() if line.startswith('{')))
        assert results[0]==results[1] and results[0]['document']['uploadReceipt']['status']=='accepted'
        print('PASS: latest upload/auth/bot migration chain; legacy definitions/ACLs/rows; real role denial; concurrent first create + append + complete; selected SQL', flush=True)
    finally:
        try:
            if launch_attempted:
                try:
                    run(['logs',name],check=False)
                finally:
                    try:
                        run(['rm','--force',name],check=False)
                    finally:
                        # Exact-name successful readback is required even if inspect/rm failed.
                        absence=run(['container','ls','--all','--filter',f'name=^/{name}$','--format','{{.Names}}'])
                        if absence.stdout.strip(): raise RuntimeError('cleanup failed')
                        removed=True
                        shutil.rmtree(run_dir/'data')
        finally:
            (log_dir/'commands.json').write_text(json.dumps(commands,indent=2)+'\n')
            print(f'Evidence: {log_dir}; container removed={removed}',flush=True)


if __name__ == '__main__':
    main()
