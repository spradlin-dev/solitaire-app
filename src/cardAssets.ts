import type { Card } from './engine/cards.ts'

// Vite glob over the vendored Knoll faces; keys look like
// './assets/cards/A-clubs.svg'. A missing or misnamed file throws at
// the first lookup for that card.
const assetUrls = import.meta.glob('./assets/cards/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

export function cardAssetUrl(card: Card): string {
  const url = assetUrls[`./assets/cards/${card.rank}-${card.suit}.svg`]
  if (!url) throw new Error(`no asset for card ${card.rank}-${card.suit}`)
  return url
}
