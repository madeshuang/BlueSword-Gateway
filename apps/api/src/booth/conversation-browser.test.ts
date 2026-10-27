import { afterEach, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { resolve } from "node:path";
import { createBoothApplication } from "./server.js";
import { readBoothConfig } from "./config.js";

let browser: Browser | undefined;
let app: ReturnType<typeof createBoothApplication> | undefined;
afterEach(async () => {
  await browser?.close();
  browser = undefined;
  await app?.close();
  app = undefined;
});

async function setup(beforeAdvice?: () => Promise<void>, reply = "推荐这件物品，请核对数量后确认。") {
  const config = {
    ...readBoothConfig(),
    databasePath: ":memory:",
    catalogConfirmed: true,
    dispatchUrl: "http://127.0.0.1:1/controlled-robot",
    openaiKey: "test-only",
    operatorToken: "test-only",
  };
  let dispatches = 0;
  const selected = config.products[0]!;
  app = createBoothApplication(config, {
    webDirectory: resolve("apps/web/dist"),
    transport: async () => {
      dispatches++;
      return Response.json({ success: true });
    },
    assistant: {
      advise: async () => {
        await beforeAdvice?.();
        return {
          reply,
          selection: [{ productId: selected.id, count: 1 }],
          taskStatusQuery: false,
        };
      },
    },
  });
  const port = await app.listen(0);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(4000);
  await page.goto(`http://127.0.0.1:${port}`);
  await page.getByRole("heading", { name: "你好，今天想体验什么？" }).waitFor();
  return { page, selected, dispatches: () => dispatches };
}

it("模型建议只打开核对弹窗，取消不发单，确认只发一单并接收完成结果", async () => {
  const { page, dispatches } = await setup();
  await page.getByRole("textbox", {name: "告诉助手你的需求"}).fill("帮我挑一份实用的纪念品，数量一件。");
  await page.getByRole("button", {name: "发送需求", exact: true}).click();
  const dialog = page.getByRole("dialog", { name: "确认这份取物清单" });
  await dialog.waitFor();
  expect(dispatches()).toBe(0);
  await page.screenshot({ path: ".tmp/ui-preview/order-confirmation.png" });
  await dialog.getByRole("button", { name: "暂不取物" }).click();
  await page.screenshot({ path: ".tmp/ui-preview/conversation.png" });
  expect(dispatches()).toBe(0);
  await page.getByRole("button", { name: "核对并确认", exact: true }).click();
  await dialog.getByRole("button", { name: "确认取物", exact: true }).click();
  await page.getByRole("button", { name: /查看取物进度/ }).waitFor();
  await expect.poll(dispatches).toBe(1);
  await expect
    .poll(() => app!.service.snapshot().active?.status)
    .toBe("executing");
  app!.service.finished();
  await page.getByRole("dialog", { name: "取物已完成" }).waitFor();
  expect(dispatches()).toBe(1);
}, 20000);

it("手动选择与数量调整保留，确认前库存变更阻止发单，移动端不溢出", async () => {
  const { page, selected, dispatches } = await setup();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "浏览并选择物品" }).click();
  await page
    .getByRole("button", { name: `选择${selected.name}`, exact: true })
    .click();
  await page.getByRole("button", { name: "核对选择", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "确认这份取物清单" });
  await dialog.waitFor();
  await dialog
    .getByRole("button", { name: `增加${selected.name}数量` })
    .click();
  expect(await dialog.getByText("共 2 件", { exact: true }).isVisible()).toBe(
    true,
  );
  const stock = await app!.service.dispatch(
    [{ productId: selected.id, count: 2 }],
    "outside-request",
  );
  expect(stock.status).toBe("executing");
  app!.service.finished();
  await page
    .getByRole("dialog", { name: "取物已完成" })
    .getByRole("button", { name: "知道了" })
    .click();
  await page.getByRole("button", { name: "核对并确认", exact: true }).click();
  await dialog.getByText(/库存不足/).waitFor();
  await expect
    .poll(() =>
      dialog.getByRole("button", { name: "确认取物", exact: true }).isEnabled(),
    )
    .toBe(false);
  expect(dispatches()).toBe(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  expect(await dialog.isVisible()).toBe(false);
}, 20000);

it("延迟的模型建议不会覆盖手动选择或擅自弹出确认", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { page, dispatches } = await setup(() => gate);
  await page.getByRole("textbox", {name: "告诉助手你的需求"}).fill("帮我挑一份实用的纪念品，数量一件。");
  await page.getByRole("button", {name: "发送需求", exact: true}).click();
  await page.getByText("正在整理回复…", { exact: true }).waitFor();
  await page.getByRole("button", { name: "浏览并选择物品" }).click();
  const manual = app!.service.snapshot().products[1]!;
  await page
    .getByRole("button", { name: `选择${manual.name}`, exact: true })
    .click();
  await page.getByRole("button", { name: "稍后再选", exact: true }).click();
  release();
  await page
    .getByText("推荐这件物品，请核对数量后确认。", { exact: true })
    .waitFor();
  expect(await page.getByRole("dialog").count()).toBe(0);
  await page.getByRole("button", { name: "核对并确认", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "确认这份取物清单" });
  expect(await dialog.getByText(manual.name, { exact: true }).isVisible()).toBe(
    true,
  );
  expect(dispatches()).toBe(0);
}, 20000);

it("工作人员补货需要凭据、现场核对和第二次确认", async () => {
  const { page, selected, dispatches } = await setup();
  await app!.service.dispatch(
    [{ productId: selected.id, count: 1 }],
    "stock-test",
  );
  app!.service.finished();
  const available = () =>
    app!.service.snapshot().products.find((p) => p.id === selected.id)!
      .availableCount;
  const before = available();
  await page
    .getByRole("dialog", { name: "取物已完成" })
    .getByRole("button", { name: "知道了" })
    .click();
  await page.getByRole("button", { name: "工作人员", exact: true }).click();
  await page.getByLabel("工作人员凭据", { exact: true }).fill("test-only");
  await page.getByText("库存补货", { exact: true }).click();
  const reset = page.getByRole("button", {
    name: "重置所选物品库存",
    exact: true,
  });
  expect(await reset.isEnabled()).toBe(false);
  await page.getByLabel("已核对并补满所选物品", { exact: true }).check();
  await reset.click();
  await page.getByRole("dialog", { name: "确认工作人员操作" }).waitFor();
  expect(available()).toBe(before);
  await page.getByRole("button", { name: "确认操作", exact: true }).click();
  await page.getByText("库存已更新", { exact: true }).waitFor();
  expect(available()).toBe(before + 1);
  expect(dispatches()).toBe(1);
}, 20000);

it("超时执行任务需工作人员现场核对并二次确认后解除", async () => {
  const { page, selected } = await setup();
  const task = await app!.service.dispatch(
    [{ productId: selected.id, count: 1 }],
    "overdue-ui",
  );
  app!.service.storage.set("booth_tasks", task.id, {
    ...task,
    createdAt: new Date(Date.now() - 300000).toISOString(),
  });
  await page.reload();
  await page
    .getByRole("dialog", { name: "取物等待时间较长" })
    .getByRole("button", { name: "知道了" })
    .click();
  await page.getByRole("button", { name: "工作人员", exact: true }).click();
  await page.getByLabel("工作人员凭据", { exact: true }).fill("test-only");
  await page
    .getByLabel("已现场核对机器人停止及物品情况", { exact: true })
    .check();
  await page
    .getByRole("button", { name: "解除新任务限制", exact: true })
    .click();
  expect(app!.service.snapshot().active?.status).toBe("executing");
  await page
    .getByRole("dialog", { name: "确认工作人员操作" })
    .getByRole("button", { name: "确认操作", exact: true })
    .click();
  await page.getByText("已解除新任务限制", { exact: true }).waitFor();
  expect(app!.service.snapshot().active).toBeNull();
  expect(app!.service.snapshot().tasks[0]!.status).toBe("resolved");
}, 20000);


it("品牌标识在长对话、侧栏收起和手机上保持可见", async () => {
  const { page } = await setup(undefined, "我是布鲁，很高兴为你介绍兰剑展台的物品。\n\n".repeat(28));
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const logo = page.locator(".header-assistant-brand");
  const assertBrand = async () => {
    expect(await logo.innerText()).toBe("BLUE BRAIN · 智能取物体验");
    expect(await logo.locator("img").count()).toBe(0);
    const bounds = await logo.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThan(120);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator(".conversation-composer").evaluate(el => el.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
  };
  await assertBrand();
  expect(await page.locator(".conversation-app").evaluate(el => getComputedStyle(el).getPropertyValue("--brand").trim())).toBe("#007687");
  await page.screenshot({ path: ".tmp/ui-preview/desktop-welcome.png" });
  await page.getByRole("textbox", {name: "告诉助手你的需求"}).fill("帮我挑一份纪念品");
  await page.getByRole("button", {name: "发送需求", exact: true}).click();
  await page.getByRole("dialog", {name: "确认这份取物清单"}).getByRole("button", {name: "暂不取物"}).click();
  await page.locator(".conversation-scroll").evaluate(el => { el.scrollTop = el.scrollHeight; });
  await assertBrand();
  await page.screenshot({ path: ".tmp/ui-preview/desktop-conversation.png" });
  await page.getByRole("button", {name: "收起侧边栏"}).click();
  await assertBrand();
  await page.setViewportSize({width: 390, height: 844});
  await assertBrand();
  await page.screenshot({ path: ".tmp/ui-preview/mobile-conversation.png" });
  await page.getByRole("button", {name: "打开导航"}).click();
  await page.getByRole("dialog").getByRole("button", {name: "开启新对话", exact: true}).click();
  await page.getByRole("dialog").getByRole("button", {name: "开启新对话", exact: true}).click();
  await page.getByRole("heading", {name: "你好，今天想体验什么？"}).waitFor();
  await assertBrand();
  await page.screenshot({ path: ".tmp/ui-preview/mobile-welcome.png" });
  await page.setViewportSize({width: 320, height: 640});
  await assertBrand();
  expect(errors).toEqual([]);
}, 20000);

it("工作人员确认期间任务变化时拒绝处理新任务", async () => {
  const { page, selected } = await setup();
  await app!.service.dispatch([{productId: selected.id, count: 1}], "recovery-first");
  await page.getByRole("button", {name: "工作人员", exact: true}).click();
  await page.getByLabel("工作人员凭据", {exact: true}).fill("test-only");
  await page.getByLabel("已现场核对机器人停止及物品情况", {exact: true}).check();
  await page.getByRole("button", {name: "解除新任务限制", exact: true}).click();
  await page.getByRole("dialog", {name: "确认工作人员操作"}).waitFor();
  app!.service.finished();
  const next = await app!.service.dispatch([{productId: selected.id, count: 1}], "recovery-second");
  await page.getByRole("button", {name: "确认操作", exact: true}).click();
  await page.getByRole("alert").filter({hasText: "任务或告警已变化"}).waitFor();
  expect(app!.service.snapshot().active?.id).toBe(next.id);
  expect(app!.service.snapshot().active?.status).toBe("executing");
  expect(await page.getByRole("button", {name: "确认操作", exact: true}).isEnabled()).toBe(false);
}, 20000);

it("不同显示器下内容放大且不横向溢出，输入框和标识保持可见", async () => {
  const { page } = await setup();
  for (const [width, height] of [[320,640],[390,844],[768,1024],[1024,768],[1366,768],[1440,900],[1920,1080],[2560,1440],[3840,2160],[1366,600]]) {
    await page.setViewportSize({width: width!, height: height!});
    const layout = await page.evaluate(() => {
      const scroll = document.querySelector('.conversation-scroll')!;
      const composer = document.querySelector('.conversation-composer')!.getBoundingClientRect();
      const logo = document.querySelector('.header-assistant-brand')!.getBoundingClientRect();
      return {
        pageFits: document.documentElement.scrollWidth <= innerWidth,
        contentFits: scroll.scrollWidth <= scroll.clientWidth,
        inputVisible: composer.bottom <= innerHeight && composer.top > logo.bottom,
        logoVisible: logo.top >= 0 && logo.bottom <= innerHeight,
        welcomeVisible: document.querySelector(".welcome-brand-lockup")!.getBoundingClientRect().top >= scroll.getBoundingClientRect().top - 1,
        contentWidth: document.querySelector('.conversation-column')!.getBoundingClientRect().width,
      };
    });
    expect(layout.welcomeVisible, `${width}: welcome clipped`).toBe(true);
    expect(layout.pageFits, `${width}: page overflow`).toBe(true);
    expect(layout.contentFits, `${width}: content overflow`).toBe(true);
    expect(layout.inputVisible, `${width}: input hidden`).toBe(true);
    expect(layout.logoVisible, `${width}: logo hidden`).toBe(true);
    if (width! >= 1920) expect(layout.contentWidth).toBeGreaterThan(880);
    if ([390,1366,1920,3840].includes(width!)) await page.screenshot({path: `.tmp/ui-preview/scaled-${width}x${height}.png`});
  }
  await page.setViewportSize({width:1920,height:1080});
  await page.getByRole("textbox", {name: "告诉助手你的需求"}).fill("帮我挑一份纪念品");
  await page.getByRole("button", {name: "发送需求", exact: true}).click();
  await page.getByRole('dialog',{name:'确认这份取物清单'}).getByRole('button',{name:'暂不取物'}).click();
  expect(await page.locator('.assistant-identity').innerText()).toBe('兰剑助手');
  await page.screenshot({path: '.tmp/ui-preview/scaled-conversation.png'});
}, 20000);
