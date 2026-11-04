async root => {
  const context = await root.context().browser().newContext();
  const page = await context.newPage();
  const outgoing = [];
  let socket, connected;
  const ready = new Promise(resolve => connected = resolve);
  try {
    await page.route('**/api/**', route => route.fulfill({json:{mode:'local',local:{enabled:false,active:false,tts:false,status:'隔离测试',phase:'idle'}}}));
    await page.routeWebSocket('**/ws', ws => {
      socket = ws;
      ws.onMessage(message => {
        const event = JSON.parse(message);
        outgoing.push(event);
        if(event.type === 'confirm_response') ws.send(JSON.stringify({type:'confirm_closed',id:event.id,reason:'approved'}));
      });
      ws.send(JSON.stringify({type:'device',online:true,name:'受控事件服务'}));
      ws.send(JSON.stringify({type:'backend',mode:'mock',show_camera:false,boot_id:'fallback-test',recovery_required:false}));
      connected();
    });
    await page.goto(new URL(root.url()).origin);
    await ready;
    await page.getByText('已连接', {exact:true}).waitFor();
    const send = event => socket.send(JSON.stringify(event));
    send({type:'asr',text:'拿一瓶水',final:true});
    send({type:'phase',phase:'thinking'});
    send({type:'assistant_start',id:'stock',display_budget_ms:1500});
    // Mount a live turn before completing the first message, so pacing is enabled.
    await page.locator('.msg.assistant').waitFor();
    send({type:'skill',id:'stock',call_id:'stock-call',name:'check_inventory',title:'查询库存',status:'done'});
    send({type:'assistant_end',id:'stock'});
    send({type:'assistant_start',id:'broken',display_budget_ms:1500});
    send({type:'reasoning_delta',id:'broken',text:'旧的半段思考'});
    send({type:'assistant_delta',id:'broken',text:'旧的半句回复'});
    send({type:'assistant_abort',id:'broken'});
    send({type:'assistant_delta',id:'broken',text:'不应复活的迟到输出'});
    send({type:'assistant_end',id:'broken'});
    await page.evaluate(() => {
      const started = performance.now();
      window.__fallbackReadyMs = null;
      function tick() {
        const button = document.querySelector('.confirm-bar-yes');
        if(button && !button.disabled && button.getBoundingClientRect().height > 0) {
          window.__fallbackReadyMs = performance.now() - started;
        } else requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
    send({type:'assistant_start',id:'backup',display_budget_ms:1500});
    send({type:'reasoning_delta',id:'backup',text:Array.from({length:200},(_,i)=>`第${i+1}件物品已核对库存，确认之后再行动。`).join('')});
    await page.waitForFunction(() => {
      const length = document.querySelector('.reasoning-body')?.textContent.length ?? 0;
      return length > 0 && length < 2000;
    });
    send({type:'reasoning_end',id:'backup',ms:100});
    send({type:'assistant_delta',id:'backup',text:'请确认这一瓶水。'});
    send({type:'skill',id:'backup',call_id:'order',name:'fetch_items',title:'取物',target:'水 × 1',status:'pending'});
    send({type:'confirm_request',id:'confirm',title:'确认取物',message:'允许取一瓶水吗？',timeout_s:180});
    await page.locator('.confirm-bar-yes').click({trial:true,timeout:3000});
    const elapsed = await page.evaluate(() => window.__fallbackReadyMs);
    if(elapsed === null || elapsed < 1400 || elapsed > 2100) throw Error('Presentation did not exercise the response deadline: '+elapsed);
    if((await page.locator('.reasoning-body').innerText()).length < 2000) throw Error('Long reasoning fixture was filtered; deadline test is invalid');
    const body = await page.locator('body').innerText();
    if(/旧的半|不应复活/.test(body)) throw Error('Failed attempt survived replacement');
    if(await page.locator('.skill.done').count() !== 1) throw Error('Completed inventory was lost or duplicated');
    if(await page.getByRole('alertdialog').count() !== 1) throw Error('Duplicate confirmation');
    await page.locator('.confirm-bar-yes').click();
    await page.waitForFunction(() => !document.querySelector('.confirm-bar-yes'));
    if(outgoing.filter(e=>e.type==='confirm_response'&&e.approved).length!==1) throw Error('Confirmation was not sent exactly once');
    return {controlledEvents:true,hardware:false,confirmationOperableMs:elapsed,abortedAttemptRemoved:true,completedToolRetained:true,oneConfirmation:true};
  } finally {
    await context.close();
  }
}
