"""HTTP callback/dispatch ordering at public task and inventory interfaces."""
import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path
from tempfile import TemporaryDirectory

import httpx
import pytest

from bluesword.app import create_app
from bluesword.config import Settings


@asynccontextmanager
async def gateway_with_robot(respond, protocol='vlm'):
    with TemporaryDirectory() as directory:
        catalog = Path(directory) / 'catalog.json'
        rows = json.loads((Path(__file__).resolve().parents[2] / 'config/booth-catalog.example.json').read_text())
        for row in rows:
            row['location'] = '测试货架'
        catalog.write_text(json.dumps(rows))
        settings = Settings(robot_mode='lanjian_http', robot_protocol=protocol, db_path=':memory:',
                            robot_dispatch_url='http://robot.invalid/api/task/dispatch', operator_token='test-only', catalog_path=str(catalog))
        app = create_app(settings)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://gateway') as gateway:
                async def robot(request):
                    if request.url.path == '/api/health':
                        return httpx.Response(200, json={'success': True, 'busy': False})
                    assert request.extensions['timeout']['read'] == 8
                    return await respond(gateway, json.loads(request.content))
                await app.state.manager.bundle.robot.client.aclose()
                app.state.manager.bundle.robot.client = httpx.AsyncClient(transport=httpx.MockTransport(robot))
                yield gateway


async def final(client, identifier):
    async with asyncio.timeout(2):
        while True:
            task = (await client.get('/api/tasks/' + identifier)).json()
            if task['status'] != 'running':
                return task
            await asyncio.sleep(.005)


async def stock(client):
    rows = (await client.get('/api/operator/inventory', headers={'X-Operator-Token': 'test-only'})).json()
    return {row['id']: row['count'] for row in rows}


@pytest.mark.parametrize('protocol', ['vlm', 'progress'])
@pytest.mark.parametrize('answer', ['lost', 'malformed', 'rejected', 'ok'])
@pytest.mark.parametrize('kind', ['finished', 'error'])
async def test_accepted_terminal_callback_survives_dispatch_response(kind, answer, protocol):
    async def robot(client, order):
        payload = {'taskId': order['taskId'], **({'result': 'success'} if kind == 'finished' else {'message': '抓取故障'})}
        for _ in range(2):
            assert (await client.post('/api/task/' + kind, json=payload)).json()['success']
        if answer == 'lost':
            raise httpx.ReadTimeout('Robot executed but dispatch response was lost')
        if answer == 'malformed':
            return httpx.Response(200, text='not JSON')
        return httpx.Response(200, json={'success': answer == 'ok'})
    async with gateway_with_robot(robot, protocol) as client:
        initial = await stock(client)
        response = await client.post('/api/tasks', json={'item_id': 'aoliao', 'request_id': 'one'})
        assert response.status_code == 202
        task = await final(client, response.json()['id'])
        if kind == 'finished':
            assert task['status'] == 'completed' and task['error'] is None
            assert not task['recovery_required']
            assert (await stock(client))['aoliao'] == initial['aoliao'] - 1
        else:
            assert task['error']['code'] == 'robot_error' and '抓取故障' in task['error']['message']
            assert task['status'] == 'failed' and task['recovery_required']
            # No grasp was reported: the existing VLM failure policy returns this reservation.
            assert (await stock(client))['aoliao'] == initial['aoliao'] - (protocol != 'vlm')

        before_duplicate = await stock(client)
        await client.post('/api/task/' + kind, json={'taskId': task['id'], **(
            {'result': 'success'} if kind == 'finished' else {'message': '抓取故障'})})
        assert await stock(client) == before_duplicate
        assert (await client.get('/api/tasks/' + task['id'])).json()['status'] == task['status']
        entries = (await client.get('/api/operator/protocol', headers={'X-Operator-Token': 'test-only'})).json()['entries']
        assert sum(row['path'] == '/api/task/dispatch' for row in entries) == 1


@pytest.mark.parametrize('protocol', ['vlm', 'progress'])
@pytest.mark.parametrize('evidence', ['none', 'wrong_id', 'missing_id', 'progress_only'])
async def test_missing_current_terminal_stays_uncertain_without_resend(protocol, evidence):
    async def robot(client, order):
        if evidence in ('wrong_id', 'missing_id'):
            payload = {'result': 'success'}
            if evidence == 'wrong_id':
                payload['taskId'] = 'previous-task'
            assert not (await client.post('/api/task/finished', json=payload)).json()['success']
        if evidence == 'progress_only':
            payload = {'taskId': order['taskId'], 'stage': 'arrived_shelf', 'stageIndex': 1,
                       'stageTotal': 5, 'pickIndex': 1, 'message': '到达货架', 'status': 'done'}
            assert (await client.post('/api/task/progress', json=payload)).json()['success']
        raise httpx.ReadTimeout('No terminal confirmation')
    async with gateway_with_robot(robot, protocol) as client:
        initial = await stock(client)
        response = await client.post('/api/tasks', json={'item_id': 'aoliao', 'request_id': 'uncertain'})
        task = await final(client, response.json()['id'])
        assert task['status'] == 'failed' and task['error']['code'] == 'dispatch_uncertain'
        assert task['recovery_required']
        assert (await stock(client))['aoliao'] == initial['aoliao'] - 1
        entries = (await client.get('/api/operator/protocol', headers={'X-Operator-Token': 'test-only'})).json()['entries']
        assert sum(row['path'] == '/api/task/dispatch' for row in entries) == 1


async def test_previous_duplicates_never_finish_next_order_or_settle_stock_twice():
    entered, release = asyncio.Event(), asyncio.Event()
    orders = []
    async def robot(client, order):
        orders.append(order['taskId'])
        if len(orders) == 1:
            for _ in range(2):
                assert (await client.post('/api/task/finished', json={'taskId': order['taskId'], 'result': 'success'})).json()['success']
        else:
            entered.set()
            await release.wait()
        raise httpx.ReadTimeout('Dispatch reply lost')
    async with gateway_with_robot(robot) as client:
        initial = await stock(client)
        first = (await client.post('/api/tasks', json={'item_id': 'aoliao', 'request_id': 'first'})).json()['id']
        assert (await final(client, first))['status'] == 'completed'
        second = (await client.post('/api/tasks', json={'item_id': 'aoliao', 'request_id': 'second'})).json()['id']
        await asyncio.wait_for(entered.wait(), 1)
        for path, body in [('finished', {'result': 'success'}), ('error', {'message': '旧任务故障'})]:
            assert not (await client.post('/api/task/' + path, json={'taskId': first, **body})).json()['success']
        assert (await client.get('/api/tasks/' + second)).json()['status'] == 'running'
        release.set()
        task = await final(client, second)
        assert task['error']['code'] == 'dispatch_uncertain' and task['recovery_required']
        assert (await client.get('/api/tasks/' + first)).json()['status'] == 'completed'
        assert (await stock(client))['aoliao'] == initial['aoliao'] - 2
        assert len(orders) == 2


async def test_v1_without_task_id_keeps_conservative_dispatch_failure():
    async def robot(client, order):
        assert (await client.post('/api/task/finished', json={'result': 'success'})).json()['success']
        raise httpx.ReadTimeout('Legacy reply lost')
    async with gateway_with_robot(robot, 'v1') as client:
        response = await client.post('/api/tasks', json={'item_id': 'aoliao', 'request_id': 'legacy'})
        task = await final(client, response.json()['id'])
        assert task['error']['code'] == 'dispatch_uncertain' and task['recovery_required']


@pytest.mark.parametrize('protocol', ['vlm', 'progress'])
async def test_clean_rejection_without_terminal_returns_inventory(protocol):
    async def robot(client, order):
        return httpx.Response(200, json={'success': False, 'data': 'Robot busy'})
    async with gateway_with_robot(robot, protocol) as client:
        initial = await stock(client)
        response = await client.post('/api/tasks', json={'item_id': 'aoliao', 'request_id': 'rejected'})
        task = await final(client, response.json()['id'])
        assert task['error']['code'] == 'rejected' and not task['recovery_required']
        assert await stock(client) == initial


async def test_early_partial_completion_keeps_quantity_check_and_reservations():
    async def robot(client, order):
        assert (await client.post('/api/task/progress', json={
            'taskId': order['taskId'], 'stage': 'grasped', 'stageIndex': 3,
            'stageTotal': 8, 'pickIndex': 1, 'message': '已抓取第一件',
        })).json()['success']
        assert (await client.post('/api/task/finished', json={'taskId': order['taskId'], 'result': 'success'})).json()['success']
        raise httpx.ReadTimeout('Dispatch response lost')
    async with gateway_with_robot(robot) as client:
        initial = await stock(client)
        response = await client.post('/api/tasks', json={'items': [
            {'item_id': 'aoliao', 'count': 1}, {'item_id': 'shupian', 'count': 1}], 'request_id': 'partial'})
        task = await final(client, response.json()['id'])
        assert task['status'] == 'completed' and task['recovery_required']
        assert task['completion_note'] and not task['error']
        remaining = await stock(client)
        assert remaining['aoliao'] == initial['aoliao'] - 1
        assert remaining['shupian'] == initial['shupian'] - 1
