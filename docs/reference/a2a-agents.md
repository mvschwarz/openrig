# Handing work between OpenRig and A2A agents

An OpenRig seat can give a queue row's task to an outside A2A agent. In the other direction, an A2A server can
front a seat's queue and return its answer as an artifact. These are compositions of the
[official Python SDK](https://github.com/a2aproject/a2a-python) and existing `rig queue` commands, not a
`rig a2a` command or a daemon endpoint. The scripts below are examples you run and own.

OpenRig does not configure the outside agent's permissions, model or credentials. Choose a peer and task content
you are authorized to share. The peer's result is its report, not acceptance of the work by your team.

## Before either recipe

Use a working OpenRig installation and an existing seat. `rig whoami --json` identifies your seat;
`rig ps --nodes --rig <rig>` shows the receiving seat's canonical session name. If you need a team first, use
[getting started](getting-started.md). Keep the daemon and provider environment you already use.

In a scratch folder, make a Python environment (Python 3.10 or newer, with `venv` and `pip` available):

```sh
python3 -m venv .venv
.venv/bin/python -m pip install 'a2a-sdk[http-server]==1.1.0' httpx uvicorn
```

The examples pin the SDK version used in the pipe trials; they are not a recommendation to downgrade another
application. The official SDK 1.1.0 paths were exercised in both directions. Other 1.x versions were not tested.
Recheck the API and cancellation behavior when changing versions.

Pydantic AI 2.60.0 with FastA2A 2.1.1 did not interoperate with these SDK 1.1.0 recipes in the tested setup:
FastA2A's inbound typed client returned `result={}` even though the SDK front, with 0.3 compatibility enabled,
sent task, artifact and completed records in its raw SSE stream. Outbound, the official SDK raised a protobuf
parse error at the FastA2A task's `status.timestamp`; the full wire timestamp was not retained. When mixing
frameworks, compare the raw stream's task IDs, artifact and final status with the typed client's output.
An HTTP 200 or an empty typed result is not proof that the task succeeded. Retain the evidence before retrying.

Save this helper as `queue_io.py`:

```python
import asyncio
import json

async def rig(*args):
    child = await asyncio.create_subprocess_exec(
        'rig', *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out, err = await child.communicate()
    if child.returncode:
        raise RuntimeError(f'rig {args[:2]} exited {child.returncode}: {err.decode()} {out.decode()}')
    return json.loads(out)
```

It inherits the caller's OpenRig environment. Run queue operations in the intended seat's environment; set
`OPENRIG_URL` only when deliberately selecting another daemon. A timed-out write is uncertain: read its row and
transitions before trying again. Do not silently send the task a second time.

## Outbound: a queue task goes to an A2A peer

You need the peer's base URL and a row assigned to your seat. For a no-model peer, the official
[Hello World sample](https://github.com/a2aproject/a2a-samples/tree/6603ba3f2c31a7ef33e70b9d8b5b5f8be42ac9a3/samples/python/agents/helloworld)
returns an echo artifact. Fetch that revision:

```sh
git clone https://github.com/a2aproject/a2a-samples.git
git -C a2a-samples checkout --detach 6603ba3f2c31a7ef33e70b9d8b5b5f8be42ac9a3
```

Start the peer yourself in a separate terminal, following `a2a-samples/samples/python/agents/helloworld/README.md`.
Its default URL is `http://127.0.0.1:9999`, used below; it is available only while you run the sample.
The sample does not implement the input-required and cancellation controls described later. Use a peer that
supports those operations when testing them.

Save as `a2a_client.py`. This client also works without an OpenRig row, for the inbound recipe below.
Streaming reads have no deadline so quiet worker waits keep their stream; connection, write and pool waits are bounded to 10 seconds.
Stop the local wait with Ctrl-C or a caller-owned overall deadline; this does not confirm cancellation, so keep the task/context IDs and cancel through the peer when it is reachable.

```python
import asyncio
import json
import os
import uuid
from pathlib import Path
import httpx
from a2a.client import A2ACardResolver, ClientConfig, create_client
from a2a.helpers import new_text_message
from a2a.types import Role, SendMessageRequest
from google.protobuf.json_format import MessageToDict
from queue_io import rig

async def main():
    row_id = os.environ.get('A2A_ROW')
    text = os.environ.get('A2A_TEXT')
    if row_id:
        row = await rig('queue', 'show', row_id, '--full', '--json')
        identity = await rig('whoami', '--json')
        if row['destinationSession'] != identity['identity']['sessionName']:
            raise RuntimeError('Choose a row assigned to this seat.')
        if row['state'] == 'pending':
            await rig('queue', 'claim', row_id, '--json')
            row = await rig('queue', 'show', row_id, '--full', '--json')
        if row['state'] != 'in-progress':
            raise RuntimeError('The row is not in progress; inspect it before sending.')
        if text is None:
            text = row['body']
    if text is None:
        raise RuntimeError('Set A2A_TEXT or A2A_ROW.')
    message = new_text_message(text, role=Role.ROLE_USER)
    if os.environ.get('A2A_CONTEXT'):
        message.context_id = os.environ['A2A_CONTEXT']
    if os.environ.get('A2A_TASK'):
        message.task_id = os.environ['A2A_TASK']
    log_path = Path(f'a2a-{uuid.uuid4()}.jsonl').resolve()
    state, bound = 'UNKNOWN', False
    with log_path.open('x') as log:
        async with httpx.AsyncClient() as http:
            card = await A2ACardResolver(httpx_client=http, base_url=os.environ['A2A_URL']).get_agent_card()
        log.write(json.dumps({'card': MessageToDict(card), 'message': MessageToDict(message)}) + '\n')
        log.flush()
        client = await create_client(agent=card, client_config=ClientConfig(
            streaming=True, httpx_client=httpx.AsyncClient(timeout=httpx.Timeout(10.0, read=None))))
        try:
            async for chunk in client.send_message(SendMessageRequest(message=message)):
                event = MessageToDict(chunk)  # SDK 1.1.0 yields StreamResponse, not a tuple.
                log.write(json.dumps(event) + '\n')
                log.flush()
                print(json.dumps(event), flush=True)
                task = event.get('task')
                if task and row_id and not bound:
                    await rig('queue', 'update', row_id, '--note',
                        f"A2A peer={card.name} task={task['id']} context={task['contextId']} log={log_path}", '--json')
                    bound = True
                status = (task or event.get('statusUpdate') or {}).get('status', {})
                state = status.get('state', state)
        finally:
            await client.close()
    if row_id:
        await rig('queue', 'update', row_id, '--note', f'A2A reported {state}; full result/events: {log_path}', '--json')
    print(f'Reported state: {state}; saved events: {log_path}')

asyncio.run(main())
```

When `A2A_TEXT` is unset, the row body becomes the peer's message verbatim. Write the body as the peer's input,
or set `A2A_TEXT` to the exact text you want to send. Run it from your seat, replacing the row and peer URL:

```sh
export A2A_URL=http://127.0.0.1:9999
export A2A_ROW=<your-row-id>
.venv/bin/python a2a_client.py
```

Read the saved `artifactUpdate` parts and final status. Put the useful result on the **same** row, using a note
while work continues or a resolution when you deliberately close it. The script leaves the row owned and open:

```sh
rig queue update "$A2A_ROW" --note 'A2A result: <answer, artifact reference, and any limits>' --json
# Only when your work on the row is actually finished:
rig queue update "$A2A_ROW" --state done --closure-reason no-follow-on --resolution '<your assessed outcome>' --json
```

If the stream fails, retain its exception and log. The peer may still be working; inspect the known task before
resending. When the task asks for input, set `A2A_TASK` and `A2A_CONTEXT` to its recorded IDs and `A2A_TEXT` to the
answer, then run the client again. For a new follow-up, unset `A2A_TASK` and keep `A2A_CONTEXT`: a completed task
is not reopened. Unset `A2A_TEXT` when the next outbound task should again use its row body.

## Inbound: an A2A client reaches an OpenRig seat

Run the following server in a custodian seat's environment, with `A2A_SEAT` set to the existing worker seat's
canonical session name. The worker is a separate participant: it watches its queue, claims the row, does the work
and writes a resolution. A deterministic shell worker is enough to test this path; a model is optional.

Save as `a2a_front.py` beside `queue_io.py`:

```python
import asyncio
import json
import os
import uvicorn
from starlette.applications import Starlette
from a2a.helpers import get_message_text, new_task_from_user_message, new_text_message, new_text_part
from a2a.server.agent_execution import AgentExecutor
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes
from a2a.server.tasks import InMemoryTaskStore, TaskUpdater
from a2a.types import AgentCapabilities, AgentCard, AgentInterface, AgentSkill
from queue_io import rig

seat = os.environ['A2A_SEAT']
rows, canceling, published = {}, set(), {}

class Front(AgentExecutor):
    async def execute(self, context, events):
        task = context.current_task or new_task_from_user_message(context.message)
        if not context.current_task:
            await events.enqueue_event(task)
        update = TaskUpdater(events, task.id, task.context_id)
        published[task.id] = asyncio.Event()
        try:
            text = get_message_text(context.message)
            if task.id not in rows:
                row_id = 'qitem-a2a-' + task.id
                body = json.dumps({'taskId': task.id, 'contextId': task.context_id, 'request': text})
                await rig('queue', 'create', '--id', row_id, '--destination', seat, '--body', body,
                    '--summary', 'Inbound A2A task', '--no-nudge', '--full', '--json')
                rows[task.id] = row_id
            else:
                row_id = rows[task.id]
                await rig('queue', 'update', row_id, '--note', 'A2A answer: ' + text, '--json')
            working = False
            while True:
                row = await rig('queue', 'show', row_id, '--full', '--json')
                if task.id in canceling:
                    await asyncio.Future()  # cancel() owns the terminal event.
                if row['state'] == 'done':
                    if not row.get('resolution'):
                        await update.failed(new_text_message('Row closed without a result resolution.'))
                    else:
                        await update.add_artifact([new_text_part(row['resolution'])], name='seat-result')
                        await update.complete(new_text_message('Seat closed row ' + row_id))
                    return
                if row['state'] in ('failed', 'denied', 'handed-off'):
                    await update.failed(new_text_message(row.get('resolution') or ('Row ' + row['state'])))
                    return
                if row['state'] == 'canceled':
                    await update.cancel(new_text_message('Queue row canceled.'))
                    return
                if row['state'] == 'in-progress' and not working:
                    await update.start_work(new_text_message('Seat claimed ' + row_id))
                    working = True
                history = await rig('queue', 'transitions', row_id, '--full', '--json')
                notes = [t.get('transitionNote') or '' for t in history]
                conversation = [n for n in notes if n.startswith(('A2A question: ', 'A2A answer: '))]
                if conversation and conversation[-1].startswith('A2A question: '):
                    await update.requires_input(new_text_message(conversation[-1][14:]))
                    return
                await asyncio.sleep(1)
        except asyncio.CancelledError:
            if task.id in canceling:
                await published[task.id].wait()  # See SDK 1.1.0 cancellation note below.
            raise
        except Exception as error:
            await update.failed(new_text_message(str(error)))

    async def cancel(self, context, events):
        canceling.add(context.task_id)
        try:
            row_id = rows[context.task_id]
            await rig('queue', 'update', row_id, '--state', 'canceled', '--resolution',
                'A2A client requested cancellation; worker stop not yet confirmed.', '--json')
            await TaskUpdater(events, context.task_id, context.context_id).cancel(
                new_text_message('Queue cancellation committed; worker stop is a separate observation.'))
        finally:
            published[context.task_id].set()

card = AgentCard(name='OpenRig queue: ' + seat, version='example-1',
    description='A worker seat returns its queue resolution.',
    default_input_modes=['text/plain'], default_output_modes=['text/plain'],
    capabilities=AgentCapabilities(streaming=True),
    supported_interfaces=[AgentInterface(protocol_binding='JSONRPC', url='http://127.0.0.1:19092', protocol_version='1.0')],
    skills=[AgentSkill(id='queue-work', name='Queue work', description='Work assigned to ' + seat, tags=['queue'])])
handler = DefaultRequestHandler(agent_executor=Front(), task_store=InMemoryTaskStore(), agent_card=card)
app = Starlette(routes=[*create_agent_card_routes(card), *create_jsonrpc_routes(handler, '/')])
uvicorn.run(app, host='127.0.0.1', port=19092)
```

Start the front, then use a second terminal for the outside client:

```sh
# Custodian terminal:
export A2A_SEAT=<worker-session-from-rig-ps>
.venv/bin/python a2a_front.py

# Client terminal, in the folder with the example scripts and venv:
unset A2A_ROW A2A_TASK A2A_CONTEXT
export A2A_URL=http://127.0.0.1:19092
export A2A_TEXT='Return exactly these words: "hello from the receiving seat".'
.venv/bin/python a2a_client.py
```

The client waits while the worker does its part. In the **worker's own environment**, inspect and claim the row:

```sh
rig queue list --owned --full --json
export ROW=<the-new-qitem-a2a-id>
rig queue show "$ROW" --full --json
rig queue claim "$ROW" --json
rig queue update "$ROW" --state done --closure-reason no-follow-on --resolution 'hello from the receiving seat' --json
```

The client should receive that exact resolution as an artifact, followed by completed. Compare the artifact with
`rig queue show "$ROW" --full --json`, including the task/context IDs in the row body. The sample uses `--no-nudge`:
the worker must be watching its queue; merely starting the front does not start or wake an agent.
To wake a model worker after the row appears, run `rig send <worker-session> 'Check your queue and process the new A2A task.'`
from the custodian's environment, or remove `--no-nudge` from the front's queue-create call to request the normal queue wake.

For input-required, the worker instead records `--note 'A2A question: <question>'` and leaves the row in progress.
The client reruns with the same `A2A_TASK`, `A2A_CONTEXT` and its answer as `A2A_TEXT`. The worker reads the
`A2A answer: ` transition with `rig queue transitions "$ROW" --full --json`, then finishes that row. These prefixes
are this example's small convention, not built-in OpenRig fields. A new follow-up omits the completed task ID and
keeps the context ID; it produces a new row.

## Cancel and read the outcome honestly

For a protocol-1.0 JSON-RPC peer, a direct control request includes `A2A-Version: 1.0`. For example, after the task
is bound and working (substitute its ID; use `GetTask` with the same parameters to inspect it):

```sh
curl -sS "$A2A_URL" -H 'Content-Type: application/json' -H 'A2A-Version: 1.0' \
  --data '{"jsonrpc":"2.0","id":"cancel-1","method":"CancelTask","params":{"id":"<task-id>"}}'
```

Read the JSON body and task state, not just HTTP status. A pipe trial received HTTP 200 carrying JSON-RPC
`-32009 VERSION_NOT_SUPPORTED` when the version header was omitted. That was an error, not a completed task.
The SDK handles versioned calls; raw requests must follow the peer's advertised interface and
[protocol version rules](https://a2a-protocol.org/v1.0.0/specification/).

SDK 1.1.0's default V2 handler cancels the running producer **before** awaiting the executor's `cancel` callback.
If that callback awaits a queue write, the producer can close the event channel first. The inbound trial then
returned stale working state even though the row was canceled. The event in the example keeps that producer
alive until the callback publishes its outcome. This is specific to the exercised ordering; see the
[pinned SDK implementation](https://github.com/a2aproject/a2a-python/blob/v1.1.0/src/a2a/server/agent_execution/active_task.py).
Test it again when changing SDK versions, including an awaited external write rather than an immediate callback.

Keep these facts separate:

| A2A observation | What it means for the queue or worker |
|---|---|
| Submitted | The A2A front accepted a task; a row may not yet be created. |
| Working | This front observed the receiving seat's claim. |
| Input-required | A question needs answering; this example leaves the row in-progress. |
| Completed + artifact | The worker's stored result was returned; your assessment still belongs to you. |
| Canceled | This inbound front committed queue cancellation; an outside peer's cancellation says nothing about your outbound row. Verify separately that the worker noticed and stopped. |
| Failed / JSON-RPC error | Retain the actual error and any row effect; do not report success. |
| Disconnect / timeout | The last known state remains all you know. Inspect before retrying. |

There is no one-to-one A2A/queue state mapping. The example does not follow handoffs to another row, so it reports
that limit instead of pretending the successor's work completed. Stopping the front only detaches clients; it does
not cancel its queue rows or stop their workers. Cancel or hand off outstanding work deliberately before stopping
your server. Acknowledged cancellation does not establish that a model provider stopped spending.

## What was exercised, and what remains open

The initial trials used an OpenRig 0.7.0 candidate and SDK 1.1.0 on Linux. Outbound discovery, streamed output and
artifacts used the official Hello World sample. Deterministic peers covered input-required, cancellation, failure
and concurrency. Inbound used a private daemon and a separate no-model queue worker: five artifacts matched the
stored resolutions, two tasks overlapped without crossing IDs, and completed-task reuse left the old result
unchanged. The successful cancellation check also observed the worker stop, beyond receiving the protocol reply.

A later inbound check used an official SDK 1.1.0 client and front, an OpenRig queue row, and Pi 1.4.0 running
`openai/gpt-4o-mini`. One marker answer reached the row's resolution and the client's completed artifact. A
custodian performed the queue writes; model tools were disabled. That run used a 120-second streaming read
timeout and prompt RPC event draining, changed together. It did not separately test the unbounded read used above.

These results do not establish model quality or provider billing. Other framework versions, model tool use,
public deployment and authentication, stream reconnect, durable bridge restart, and cancellation before row
binding were not exercised. The inbound example holds A2A tasks and their row mapping in memory: keep it running for the conversation;
after a crash, inspect retained OpenRig rows before any replacement run. It binds loopback and supplies no public
authentication layer. Use it on your own machine or a trusted private path, not as an unauthenticated public gateway.
