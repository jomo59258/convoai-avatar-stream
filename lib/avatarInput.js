/** Normalize values copied from Lemonslice or an image host. */
export function normalizeLemonsliceAvatarInput(value) {
  if (typeof value !== 'string') return '';
  let input = value.trim();

  const markdownUrl = input.match(/^!?\[[^\]]*\]\((https:\/\/[^\s)]+)\)$/i);
  if (markdownUrl) input = markdownUrl[1];

  input = input.replace(/^[<'"`]+|[>'"`]+$/g, '').trim();
  if (/^agent_[A-Za-z0-9_-]+$/.test(input)) return input;

  try {
    const url = new URL(input);
    return url.protocol === 'https:' && url.hostname ? url.toString() : '';
  } catch {
    return '';
  }
}
