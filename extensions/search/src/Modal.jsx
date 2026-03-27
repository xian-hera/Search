import {
  reactExtension,
  Navigator,
  Screen,
  ScrollView,
  Text,
  TextField,
  Button,
  Stack,
  useApi,
  Badge,
  Pressable,
  Divider,
} from '@shopify/ui-extensions-react/point-of-sale'
import { useState, useRef, useEffect, useCallback } from 'react'

const SERVER_URL = "https://search-0wf4.onrender.com"
const MIN_KEYWORD_LENGTH = 4
const DEBOUNCE_MS = 300

const Modal = () => {
  const api = useApi()

  const [keyword, setKeyword]     = useState('')
  const [results, setResults]     = useState([])
  const [searched, setSearched]   = useState(false)
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState(null)
  const [cacheInfo, setCacheInfo] = useState(null)

  const debounceRef = useRef(null)

  useEffect(() => {
    fetch(`${SERVER_URL}/cache/status`)
      .then(r => r.json())
      .then(data => setCacheInfo(`${data.total} variants indexed`))
      .catch(() => setCacheInfo('Server warming up…'))
  }, [])

  const runSearch = useCallback(async (kw) => {
    if (!kw || kw.trim().length < 2) return
    setLoading(true)
    setError(null)
    try {
      const resp = await fetch(`${SERVER_URL}/search?q=${encodeURIComponent(kw.trim())}`)
      if (!resp.ok) throw new Error(`Server error: ${resp.status}`)
      const data = await resp.json()
      setResults(data.results || [])
      setSearched(true)
      if (data.total) setCacheInfo(`${data.total} variants indexed`)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (keyword.length >= MIN_KEYWORD_LENGTH) {
      debounceRef.current = setTimeout(() => runSearch(keyword), DEBOUNCE_MS)
    } else {
      setResults([])
      setSearched(false)
    }
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [keyword, runSearch])

  const handleSearch = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    runSearch(keyword)
  }

  const handleVariantPress = (variant) => {
    try {
      api.navigation.navigate('ProductVariant', { id: variant.variantNumericId })
    } catch {
      try { api.navigation.navigate('Product', { id: variant.productNumericId }) }
      catch (e) { console.error('Navigation failed:', e) }
    }
  }

  const handleRefresh = async () => {
    try {
      await fetch(`${SERVER_URL}/cache/refresh`, { method: 'POST' })
      setCacheInfo('Refreshing…')
    } catch {
      setError('Refresh failed')
    }
  }

  const charsNeeded = MIN_KEYWORD_LENGTH - keyword.length

  return (
    <Navigator>
      <Screen name="Search" title="Search">
        <ScrollView>
          <Stack direction="vertical" spacing="loose" padding="base">

            {/* Search bar — full width TextField + Search button */}
            <TextField
              label="Search"
              placeholder="SKU, barcode, title or name…"
              value={keyword}
              onChange={setKeyword}
              action={{ label: 'Search', onAction: handleSearch }}
            />

            {/* Cache info — small, right-aligned */}
            {cacheInfo && (
              <Stack direction="horizontal" spacing="tight" alignment="center" distribution="trailing">
                <Text size="small" color="TextSubdued">{cacheInfo}</Text>
                <Button title="↺" type="plain" onPress={handleRefresh} />
              </Stack>
            )}

            {loading && <Text color="TextSubdued">Searching…</Text>}
            {error && <Text color="TextCritical">Error: {error}</Text>}

            {!loading && keyword.length > 0 && keyword.length < MIN_KEYWORD_LENGTH && (
              <Text color="TextSubdued">
                {charsNeeded} more character{charsNeeded !== 1 ? 's' : ''} to auto-search
              </Text>
            )}

            {searched && !loading && results.length === 0 && (
              <Text color="TextSubdued">No variants found for "{keyword}"</Text>
            )}

            {results.length > 0 && (
              <Text size="small" color="TextSubdued">
                {results.length} result{results.length !== 1 ? 's' : ''}
                {results.length === 100 ? ' (top 100)' : ''}
              </Text>
            )}

            {results.map((variant, i) => (
              <VariantRow
                key={variant.variantId}
                variant={variant}
                onPress={handleVariantPress}
                showDivider={i < results.length - 1}
              />
            ))}

          </Stack>
        </ScrollView>
      </Screen>
    </Navigator>
  )
}

export default reactExtension('pos.home.modal.render', () => <Modal />)

function VariantRow({ variant, onPress, showDivider }) {
  const { productTitle, variantTitle, customName, sku, barcode, price, inventoryQuantity } = variant

  const isDefault   = variantTitle === 'Default Title'
  const namePart    = customName || null
  const variantPart = !isDefault ? variantTitle : null
  const subtitle    = namePart && variantPart
    ? `${namePart} · ${variantPart}`
    : namePart ?? variantPart ?? null

  const stockText =
    inventoryQuantity === null ? 'Stock N/A'
    : inventoryQuantity > 0   ? `${inventoryQuantity} in stock`
    : 'Out of stock'

  const stockColor =
    inventoryQuantity === null ? 'TextSubdued'
    : inventoryQuantity > 10  ? 'TextSubdued'
    : inventoryQuantity > 0   ? 'TextWarning'
    : 'TextCritical'

  return (
    <>
      <Pressable onPress={() => onPress(variant)}>
        <Stack direction="vertical" spacing="extraTight" padding="base">
          <Text fontWeight="bold">{productTitle}</Text>
          {subtitle && <Text color="TextSubdued">{subtitle}</Text>}
          <Stack direction="horizontal" spacing="tight">
            {sku     && <Badge status="info" text={`SKU: ${sku}`} />}
            {barcode && <Badge text={`Barcode: ${barcode}`} />}
          </Stack>
          <Stack direction="horizontal" spacing="tight">
            {price != null && (
              <Text fontWeight="bold">${parseFloat(price).toFixed(2)}</Text>
            )}
            <Text color={stockColor}>{stockText}</Text>
          </Stack>
        </Stack>
      </Pressable>
      {showDivider && <Divider />}
    </>
  )
}