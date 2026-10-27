import { describe, expect, it } from "vitest";
import type { BoothStockProduct } from "@bluesword/contracts";
import { selectionProblem } from "./selection";

const products = [
  { id: "pen", name: "圆珠笔", maxCount: 3, availableCount: 2 },
  { id: "cards", name: "扑克牌", maxCount: 2, availableCount: 0 },
] as BoothStockProduct[];
describe("确认弹窗以最新库存校验选择", () => {
  it("允许同一种两件，但不会放过超过两件或重复商品", () => {
    expect(
      selectionProblem([{ productId: "pen", count: 2 }], products),
    ).toBeNull();
    expect(
      selectionProblem([{ productId: "pen", count: 3 }], products),
    ).toContain("两件");
    expect(
      selectionProblem(
        [
          { productId: "pen", count: 1 },
          { productId: "pen", count: 1 },
        ],
        products,
      ),
    ).not.toBeNull();
  });
  it("库存耗尽、商品移除、空选择和非法数量禁止确认", () => {
    expect(
      selectionProblem([{ productId: "cards", count: 1 }], products),
    ).toContain("库存");
    expect(
      selectionProblem([{ productId: "missing", count: 1 }], products),
    ).not.toBeNull();
    expect(selectionProblem([], products)).not.toBeNull();
    expect(
      selectionProblem([{ productId: "pen", count: 0.5 }], products),
    ).not.toBeNull();
  });
});
