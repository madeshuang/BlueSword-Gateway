async root => {
  const testContext = await root.context().browser().newContext();
  const page = await testContext.newPage();
  const base = new URL(root.url()).origin;
  const check = (condition, message) => { if (!condition) throw Error(message); };
  let socket;
  try {
    await page.setViewportSize({width:1280,height:650});
    await page.route('**/api/speech', r=>r.fulfill({json:{configured:false}}));
    await page.routeWebSocket('**/ws', ws=>{
      socket=ws;
      ws.send(JSON.stringify({type:'device',online:true,name:'受控展示测试'}));
      ws.send(JSON.stringify({type:'backend',mode:'lanjian_http',recovery_required:false,show_camera:false}));
      ws.send(JSON.stringify({type:'phase',phase:'acting'}));
    });
    await page.goto(base); await page.getByText('已连接',{exact:true}).waitFor();
    const steps=Array.from({length:28},(_,i)=>({id:String(i),label:`第 ${i+1} 步`,status:'done',detail:'机器人已回报本步执行结果'}));
    const task={id:'controlled',title:'受控进度验证',status:'running',steps};
    const send=event=>socket.send(JSON.stringify(event));
    send({type:'vision',caption:'不应显示的相机说明',detections:[],scanning:true});
    send({type:'task',task});
    const panel=page.locator('.task');await panel.waitFor();
    const bottom=async()=>panel.evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop<32);
    await page.waitForTimeout(250);check(await bottom(),'Long progress did not follow');
    check(await page.locator('.feed,.caption,.live-badge').count()===0,'Camera content still displayed');
    check(await page.getByText('执行过程',{exact:false}).count()>0,'Progress hidden with camera');
    check(await page.getByText('现场协助',{exact:true}).count()>0,'Assistance hidden with camera');
    await panel.hover();await page.mouse.wheel(0,-500);await page.waitForTimeout(200);
    const previous=await panel.evaluate(el=>el.scrollTop);check(!await bottom(),'Manual scroll did not leave bottom');
    steps.push({id:'28',label:'新增进度',status:'active'});send({type:'task',task});await page.waitForTimeout(250);
    check(Math.abs(await panel.evaluate(el=>el.scrollTop)-previous)<5,'New progress interrupted manual reading');
    await page.mouse.wheel(0,10000);await page.waitForTimeout(200);
    steps.push({id:'29',label:'继续跟随',status:'active'});send({type:'task',task});await page.waitForTimeout(250);
    check(await bottom(),'Follow did not resume at bottom');
    await page.mouse.wheel(0,-500);await page.waitForTimeout(200);
    send({type:'task',task:{...task,id:'next-task',steps:[...steps,{id:'30',label:'新任务',status:'active'}]}});
    await page.waitForTimeout(250);check(await bottom(),'New task did not reset following');
    check(await page.getByText('查看最新',{exact:true}).count()===0,'Unrequested button displayed');
    return {cameraHidden:true,progressAndAssistanceRemain:true,followBottom:true,pauseWhenReading:true,resumeAtBottom:true,newTaskFollows:true};
  } finally { await testContext.close(); }
}
