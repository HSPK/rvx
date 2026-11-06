import {expect, type Locator} from "@playwright/test";

export async function selectOption(control: Locator, value: string): Promise<void> {
  if (await control.evaluate(node => node.tagName === "SELECT")) {
    await control.selectOption(value);
    return;
  }
  await control.click();
  await control.page().getByRole("option").and(control.page().locator(`[data-value=${JSON.stringify(value)}]`)).click();
}

export async function expectControlValue(control: Locator, value: string | RegExp): Promise<void> {
  if (await control.evaluate(node => ["INPUT", "SELECT", "TEXTAREA"].includes(node.tagName))) {
    await expect(control).toHaveValue(value);
  } else {
    await expect(control).toHaveAttribute("data-value", value);
  }
}

export async function sectionContent(section: Locator, selector = ".chart-card"): Promise<Locator> {
  const id = await section.getAttribute("data-section-id");
  if (!id) throw new Error("Section has no stable identity.");
  return section.page().locator(`${selector}[data-section-id=${JSON.stringify(id)}]`);
}
