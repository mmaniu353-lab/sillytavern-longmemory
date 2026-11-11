// Keep provider IDs such as "google/gemini-2.0" intact while removing private
// filesystem prefixes from legacy local-model values.
export const portableModelLabel = (value: string | undefined): string => {
  if (!value) return '';
  const model = String(value).trim();
  if (!/^[a-z]:[\\/]/i.test(model) && !model.startsWith('/') && !model.includes('\\')) {
    return model;
  }
  return model
    .replace(/\\/g, '/')
    .split('/')
    .at(-1)!
    .replace(/\.gguf$/i, '');
};
