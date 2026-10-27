import type {
  BoothSelectionItem,
  BoothStockProduct,
} from "@bluesword/contracts";

/** Re-evaluate at render/confirmation time: a model suggestion is not a reservation. */
export function selectionProblem(
  items: BoothSelectionItem[],
  products: BoothStockProduct[],
): string | null {
  if (!items.length) return "请先选择物品。";
  if (items.some((item) => !Number.isSafeInteger(item.count) || item.count < 1))
    return "请核对物品数量。";
  if (items.reduce((sum, item) => sum + item.count, 0) > 2)
    return "每单最多两件，请调整选择。";
  if (new Set(items.map((item) => item.productId)).size !== items.length)
    return "同一种物品请合并数量。";
  for (const item of items) {
    const product = products.find((product) => product.id === item.productId);
    if (!product) return "物品目录已更新，请重新选择。";
    if (item.count > product.availableCount)
      return `${product.name}库存不足，请调整选择。`;
    if (item.count > product.maxCount)
      return `${product.name}超过单品数量限制。`;
  }
  return null;
}
