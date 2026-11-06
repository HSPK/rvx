import {ExactJsonUnavailable, exactProperty, parseExactJson} from "../core/exact-json";

const previewCharacters = 64 * 1024;
interface ConfigurationPreview {text: string; notice: string | null}

function limitedConfiguration(text: string): ConfigurationPreview {
  if (text.length <= previewCharacters) return {text, notice: null};
  let end = previewCharacters;
  if (/[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
  return {text: text.slice(0, end), notice: "Showing a limited preview. Download the configuration for the complete JSON."};
}

/** Bound and format exact JSON without converting recorded integers to floating point. */
export function configurationPreview(text: string): ConfigurationPreview {
  const limited = limitedConfiguration(text);
  if (limited.notice) return limited;
  let wrapper: {configuration: unknown};
  try {
    JSON.parse(text);
    wrapper = parseExactJson(`{"configuration":${text}}`);
  } catch (error) {
    if (error instanceof SyntaxError) return {text, notice: "Invalid configuration JSON. Showing the stored text."};
    if (error instanceof ExactJsonUnavailable) return {text, notice: "This browser cannot format exact numeric values. Showing the stored JSON."};
    throw error;
  }
  const pending = [{value: wrapper.configuration, depth: 0}];
  let visited = 0;
  while (pending.length) {
    const {value, depth} = pending.pop()!;
    if (++visited > 4000 || depth > 24) return {text, notice: "Complex configuration is shown without formatting. The download remains complete."};
    if (value !== null && typeof value === "object") {
      const children: unknown[] = Object.values(value);
      if (visited + pending.length + children.length > 4000) return {text, notice: "Large configuration is shown without formatting. The download remains complete."};
      for (const child of children) pending.push({value: child, depth: depth + 1});
    }
  }
  return limitedConfiguration(exactProperty(wrapper, "configuration", 2));
}
