#!/usr/bin/env python3
"""Linux-only PTY owner for one Antigravity TUI and one agmsg role."""
import argparse, hashlib, json, os, pty, re, select, signal, subprocess, sys, termios, time, tty, uuid
from pathlib import Path

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[3]
TRANSPORT=str(HERE/'inbox-transport.sh')

def atomic(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp=path.with_name(path.name+f'.{os.getpid()}.tmp')
    fd=os.open(tmp, os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(value, f, ensure_ascii=False); f.write('\n'); f.flush(); os.fsync(f.fileno())
    os.replace(tmp, path)

def proc_start(pid):
    return Path(f'/proc/{pid}/stat').read_text().split(') ',1)[1].split()[19]

class Supervisor:
    def __init__(self, args):
        self.a=args; self.project=str(Path(args.project).resolve()); self.owner=f'{uuid.uuid4()}.{os.getpid()}'
        self.start=proc_start(os.getpid()); self.cap=uuid.uuid4().hex+uuid.uuid4().hex
        paths=self.call('paths').splitlines(); self.actas=Path(paths[0])
        key=self.actas.name.removeprefix('actas.').removesuffix('.session')
        self.state_file=ROOT/'run'/f'antigravity-tui-pty.{key}.state.json'
        self.reservation=ROOT/'run'/f'antigravity-reservation.{key}.json'; self.violations=Path(str(self.reservation)+'.violations')
        self.state={'schemaVersion':1,'project':self.project,'team':args.team,'role':args.name,'owner':self.owner,'supervisorPhase':'STARTING','manualResumeRequired':False,'batch':None}
        self.master=None; self.child=None; self.old=None; self.stopping=False; self.stop_reason=None; self.buffer=''; self.result_buffer=''; self.last_poll=0; self.idle_ready=False; self.human_input_seen=False; self.resume_requested=False; self.render_seen=False
        signal.signal(signal.SIGTERM, self.request_stop)
        signal.signal(signal.SIGINT, self.request_stop)
        signal.signal(signal.SIGUSR1, self.request_resume)
    def request_stop(self, signum, _frame):
        self.stop_reason=f'外部停止要求({signal.Signals(signum).name})'
    def request_resume(self, _signum, _frame):
        self.resume_requested=True
    def call(self, command, extra=(), input=None, cap=False):
        fds=()
        passfds=()
        preexec=None
        if cap:
            r,w=os.pipe(); os.write(w,(self.cap+'\n').encode()); os.close(w); fds=(r,); passfds=(r,3)
            preexec=lambda: os.dup2(r,3)
        try:
            p=subprocess.run(['bash',TRANSPORT,command,self.project,self.a.team,self.a.name,self.owner,*extra],input=input,text=True,capture_output=True,pass_fds=passfds,preexec_fn=preexec)
        finally:
            for fd in fds: os.close(fd)
        if p.returncode: raise RuntimeError(f'{command}失敗: {p.stderr.strip()}')
        return p.stdout
    def save(self): atomic(self.state_file,self.state)
    def fail(self, why):
        if self.state.get('batch') and self.state['batch'].get('phase')!='completed': self.state['batch']['phase']='uncertain'
        self.state['supervisorPhase']='NEEDS_ATTENTION'; self.save(); print(f'\r\n{why}; ackせず停止します',file=sys.stderr); self.stopping=True
    def check_guard(self):
        reservation=json.loads(self.reservation.read_text())
        if reservation['owner']!=self.owner or reservation['start']!=self.start: raise RuntimeError('予約所有権不一致')
        if proc_start(os.getpid())!=self.start: raise RuntimeError('supervisor start token不一致')
        if self.actas.read_text().strip()!=self.owner: raise RuntimeError('actas所有権不一致')
        if self.violations.exists() and self.violations.read_text().strip(): raise RuntimeError('通常inboxによる既読試行を検知')
        if self.child and proc_start(self.child)!=self.state.get('childStart'): raise RuntimeError('agy child start token不一致')
    def acquire(self):
        mode=Path(self.project)/'.agent/rules/agmsg.md'
        if not mode.exists() or '<!-- agmsg:antigravity:monitor -->' not in mode.read_text(): raise RuntimeError('monitor設定が必要')
        if self.reservation.exists():
            old=json.loads(self.reservation.read_text())
            try:
                if proc_start(int(old['pid']))==old['start']: raise RuntimeError('既存Antigravity bridge/TUI supervisor が稼働中です')
            except (FileNotFoundError,ProcessLookupError,ValueError): pass
            if self.state_file.exists():
                old_state=json.loads(self.state_file.read_text())
                if old_state.get('batch') and old_state['batch'].get('phase')!='completed': raise RuntimeError('未解決batchです。ack/replayで復旧してください')
            self.reservation.unlink()
        if self.state_file.exists():
            saved=json.loads(self.state_file.read_text())
            if any(saved.get(k)!=self.state[k] for k in ('project','team','role')): raise RuntimeError('state不一致')
            self.state=saved
            self.state['owner']=self.owner
        self.claim_reservation()
    def claim_reservation(self):
        self.call('claim'); self.state['owner']=self.owner; self.save(); self.violations.parent.mkdir(mode=0o700,exist_ok=True)
        self.violations.touch(mode=0o600,exist_ok=True); Path(str(self.violations)+'.lock').touch(mode=0o600,exist_ok=True)
        # bridge-read-guard は fd 3 から改行を除いた値をハッシュする。
        atomic(self.reservation,{'owner':self.owner,'pid':os.getpid(),'start':self.start,'state':str(self.state_file),'actas':str(self.actas),'violations':str(self.violations),'capHash':hashlib.sha256(self.cap.encode()).hexdigest(),'kind':'tui-pty'})
    def launch(self):
        pid, master=pty.fork()
        if pid==0:
            attrs=termios.tcgetattr(0); attrs[3]&=~(termios.ECHO|termios.ECHONL); termios.tcsetattr(0,termios.TCSANOW,attrs)
            os.chdir(self.project); os.execvp(self.a.agy,[self.a.agy])
        self.child=pid; self.master=master; self.old=termios.tcgetattr(sys.stdin.fileno()); tty.setraw(sys.stdin.fileno())
        self.state.update({'childPid':pid,'childStart':proc_start(pid),'supervisorPhase':'WAITING_FOR_IDLE'}); self.save()
    def envelope(self, batch):
        digest=hashlib.sha256(','.join(m['id'] for m in batch['messages']).encode()).hexdigest()[:16]
        out=[f'[agmsg batch id={batch["id"]} receipt={digest} count={len(batch["messages"])}]']
        for m in batch['messages']:
            body=m['body'].replace('\x1b','\\x1b')
            out += [f'[agmsg message id={m["id"]}]',f'from: {m["from"]}',f'at: {m["at"]}','body:',body,'[/agmsg message]']
        out += ['[/agmsg batch]',f'この受信を読んだら、最初に AGMSG_RECEIVED:{batch["id"]}:{digest} だけを出力し、その後に通常どおり処理してください。']
        return '\n'.join(out)
    def inject(self):
        b=self.state['batch']; data=self.envelope(b).encode()
        os.write(self.master,b'\x1b[200~'+data+b'\x1b[201~\r')
        b['phase']='sent'; b['receipt']=f'AGMSG_RECEIVED:{b["id"]}:{hashlib.sha256(",".join(m["id"] for m in b["messages"]).encode()).hexdigest()[:16]}'
        self.result_buffer=''; self.render_seen=False
        self.state['supervisorPhase']='INJECTED'; self.save(); self.state['supervisorPhase']='WAITING_FOR_RESULT'; self.save()
    @staticmethod
    def exact_line(text, expected):
        clean=re.sub(r'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))','',text)
        return any(line.strip()==expected for line in clean.splitlines())
    def ack(self):
        self.check_guard()
        b=self.state['batch']; b['phase']='completed'; self.state['supervisorPhase']='ACK_PENDING'; self.save()
        try: self.call('ack',input=json.dumps([m['id'] for m in b['messages']]),cap=True)
        except Exception:
            b['phase']='uncertain'; self.state['supervisorPhase']='NEEDS_ATTENTION'; self.save(); raise
        self.state['batch']=None; self.state['supervisorPhase']='WAITING_FOR_IDLE'; self.save()
    def maybe_poll(self):
        if self.state['batch'] or time.monotonic()-self.last_poll<self.a.poll: return
        self.check_guard()
        if not self.idle_ready or self.human_input_seen: return
        self.last_poll=time.monotonic(); rows=self.call('peek').strip()
        if not rows:return
        msgs=[json.loads(x) for x in rows.splitlines()]; chosen=[]; size=0
        for m in msgs:
            n=len(m['body'].encode())
            if n>65536: self.fail(f'本文上限超過 id={m["id"]}'); return
            if size+n>65536: break
            chosen.append(m);size+=n
        if not chosen:return
        self.state['batch']={'id':str(uuid.uuid4()),'phase':'prepared','messages':chosen}; self.state['supervisorPhase']='PREPARED'; self.save()
        # 初期版は、直近出力に実測済みの prompt footer があるときだけ投入する。
        if self.idle_ready and not self.human_input_seen: self.inject()
    def loop(self):
        while not self.stopping:
            if self.resume_requested:
                self.resume_requested=False
                if self.state.get('supervisorPhase')=='WAITING_FOR_RESULT': self.fail('受信turn中のresume要求を拒否'); continue
                self.human_input_seen=False; self.idle_ready=True; self.state['manualResumeRequired']=False; self.state['supervisorPhase']='WAITING_FOR_IDLE'; self.save()
                print('\r\n入力欄を手動確認済みとしてmonitorを再開します',file=sys.stderr)
            if self.stop_reason:
                if self.state.get('batch') and self.state['batch'].get('phase')!='completed': self.fail(self.stop_reason)
                break
            r,_,_=select.select([sys.stdin.fileno(),self.master],[],[],0.2)
            if sys.stdin.fileno() in r:
                data=os.read(sys.stdin.fileno(),4096)
                if not data: self.stopping=True; break
                if self.state.get('supervisorPhase')=='WAITING_FOR_RESULT': self.fail('受信turn中の人間入力を検知')
                else: self.human_input_seen=True; self.idle_ready=False; self.state['manualResumeRequired']=True; self.state['supervisorPhase']='WAITING_FOR_IDLE'; self.save()
                os.write(self.master,data)
            if self.master in r:
                data=os.read(self.master,65536)
                if not data: self.fail('agy TUIが終了'); break
                os.write(sys.stdout.fileno(),data); text=data.decode(errors='replace'); self.buffer=(self.buffer+text)[-65536:]
                if self.exact_line(text,'? for shortcuts') and not self.state.get('batch'):
                    self.idle_ready=True
                b=self.state.get('batch')
                if b and self.state.get('supervisorPhase')=='WAITING_FOR_RESULT':
                    self.result_buffer=(self.result_buffer+text)[-16384:]
                    if f'[agmsg batch id={b["id"]}' in text or '[/agmsg batch]' in text: self.render_seen=True
                    if re.search(r'(?i)\b(?:error|cancel(?:led)?|interrupt(?:ed)?|permission|trust|picker)\b', self.result_buffer): self.fail('TUI error/cancel/permission signatureを検知')
                    elif self.exact_line(self.result_buffer,b.get('receipt')):
                        if self.render_seen: self.fail('receiptがTUI描画由来か判別できないためackしません')
                        else: self.ack()
                elif b and self.state.get('supervisorPhase')=='PREPARED' and self.idle_ready and not self.human_input_seen:
                    self.inject()
            self.maybe_poll()
    def run(self):
        self.acquire()
        if (self.state.get('batch') or {}).get('phase')=='completed': self.ack()
        self.launch(); self.loop()
    def close(self):
        if self.old: termios.tcsetattr(sys.stdin.fileno(),termios.TCSADRAIN,self.old)
        if self.child:
            try: os.write(self.master,b'\x04')
            except (OSError,TypeError): pass
            deadline=time.monotonic()+5
            while time.monotonic()<deadline:
                try:
                    if proc_start(self.child)!=self.state.get('childStart'): break
                except (FileNotFoundError,ProcessLookupError): break
                time.sleep(0.05)
            try:
                if proc_start(self.child)==self.state.get('childStart'): os.kill(self.child,signal.SIGHUP)
            except (FileNotFoundError,ProcessLookupError): pass
        if not self.state.get('batch'):
            try:
                r=json.loads(self.reservation.read_text())
                if r['owner']==self.owner and r['start']==self.start and self.actas.read_text().strip()==self.owner: self.reservation.unlink(); self.actas.unlink(missing_ok=True)
            except Exception: pass

def recover(a):
    s=Supervisor(a)
    if not s.reservation.exists() or not s.state_file.exists(): raise RuntimeError('復旧対象の予約/stateがありません')
    reservation=json.loads(s.reservation.read_text()); state=json.loads(s.state_file.read_text()); batch=state.get('batch')
    try: live=proc_start(int(reservation['pid']))==reservation['start']
    except (FileNotFoundError,ValueError): live=False
    if live: raise RuntimeError('復旧対象のsupervisorが稼働中です')
    if not batch or batch.get('id')!=a.batch: raise RuntimeError('復旧batch IDが一致しません')
    expected=sorted(a.confirm_ids or []); actual=sorted(m['id'] for m in batch.get('messages',[]))
    if expected!=actual: raise RuntimeError('復旧batchのID集合が一致しません')
    s.state=state; s.reservation.unlink(); s.violations.write_text('')
    s.claim_reservation()
    try:
        if a.action=='ack':
            s.state['batch']['phase']='completed'; s.state['supervisorPhase']='ACK_PENDING'; s.save(); s.ack()
            print('復旧ackを完了しました')
        else:
            s.state['batch']['phase']='prepared'; s.state['supervisorPhase']='PREPARED'; s.save(); s.launch(); s.loop()
    finally:
        s.close()

def main():
    p=argparse.ArgumentParser(); p.add_argument('--project',required=True);p.add_argument('--team',required=True);p.add_argument('--name',required=True);p.add_argument('--agy',default='agy');p.add_argument('--poll',type=float,default=2);p.add_argument('--action',choices=['run','status','stop','resume','ack','replay'],default='run');p.add_argument('--batch');p.add_argument('--confirm-id',dest='confirm_ids',action='append')
    a=p.parse_args()
    if a.action in ('ack','replay'):
        if not a.batch or not a.confirm_ids: raise RuntimeError('--batch と --confirm-id が必要です')
        recover(a); return
    if a.action in ('status','stop','resume'):
        matches=[]
        for file in (ROOT/'run').glob('antigravity-reservation.*.json'):
            try:
                reservation=json.loads(file.read_text()); state=json.loads(Path(reservation['state']).read_text())
                if state.get('project')!=str(Path(a.project).resolve()) or state.get('team')!=a.team or state.get('role')!=a.name or reservation.get('kind')!='tui-pty': continue
                live=False
                try: live=proc_start(int(reservation['pid']))==reservation['start']
                except (FileNotFoundError,ValueError): pass
                matches.append((file,reservation,state,live))
            except (OSError,KeyError,TypeError,ValueError,json.JSONDecodeError):
                continue
        if a.action=='status':
            if not matches: print('runtime: tui-pty 未起動'); return
            for _,reservation,state,live in matches:
                batch=state.get('batch')
                status='paused' if state.get('manualResumeRequired') else 'busy' if batch else 'running' if live else '停止/要確認'
                print(f"runtime: {state.get('role')} tui-pty {status}")
                if batch:
                    print(f"batch: {batch.get('id')} phase={batch.get('phase')} messages={len(batch.get('messages',[]))}")
                    for message in batch.get('messages',[]): print(f"message: id={message.get('id')} from={message.get('from')} at={message.get('at')}")
            return
        live=[x for x in matches if x[3]]
        if len(live)!=1: raise RuntimeError('停止対象のTUI supervisorが一意に特定できません')
        _,reservation,_,_=live[0]
        if a.action=='resume':
            os.kill(int(reservation['pid']),signal.SIGUSR1)
            print('再開要求を送信しました。入力欄を空にしたことを確認済みの場合だけ使用してください')
            return
        os.kill(int(reservation['pid']),signal.SIGTERM)
        print('停止要求を送信しました')
        return
    s=Supervisor(a)
    try:s.run()
    except Exception as e: s.fail(str(e)); sys.exit(1)
    finally:s.close()
if __name__=='__main__': main()
