import {
  reactExtension,
  Navigator,
  Screen,
  ScrollView,
  Text,
  TextField,
  Stack,
  useApi,
  Image,
  Selectable,
} from '@shopify/ui-extensions-react/point-of-sale'
import { useState, useRef, useCallback, useEffect } from 'react'

const SERVER_URL = "https://search-0wf4.onrender.com"
const MIN_KEYWORD_LENGTH = 4
const DEBOUNCE_MS = 500
const AUTO_LIMIT = 50

const LOCATION_ORDER = [
  'MTL01','MTL02','MTL03','MTL04','MTL05','MTL06',
  'MTL07','MTL08','MTL09','MTL10','MTL11',
  'OTT01','OTT02','OTT03',
  'QC01',
  'CAL01',
  'EDM01','EDM02',
  'HQ',
]

function sortLocations(locations) {
  return [...locations].sort((a, b) => {
    const ai = LOCATION_ORDER.indexOf(a.locationName)
    const bi = LOCATION_ORDER.indexOf(b.locationName)
    if (ai !== -1 && bi !== -1) return ai - bi
    if (ai !== -1) return -1
    if (bi !== -1) return 1
    const ap = a.locationName.slice(0, 3)
    const bp = b.locationName.slice(0, 3)
    if (ap !== bp) return ap.localeCompare(bp)
    return a.locationName.localeCompare(b.locationName)
  })
}

function sortByPriority(results, kw) {
  const k = kw.toLowerCase()
  return [...results].sort((a, b) => {
    const score = (v) => {
      if ((v.customName || '').toLowerCase().includes(k)) return 0
      if ((v.productTitle || '').toLowerCase().includes(k)) return 1
      if ((v.sku || '').toLowerCase().includes(k)) return 2
      if ((v.wigNumber || '').toLowerCase().includes(k)) return 3
      return 4
    }
    return score(a) - score(b)
  })
}

// ─── Main Modal ───────────────────────────────────────────────────────────────

const Modal = () => {
  const api = useApi()
  const [selectedVariant, setSelectedVariant] = useState(null)
  const currentLocationId = api.session?.currentSession?.locationId?.toString() || null

  const handleSelectVariant = useCallback((variant) => {
    setSelectedVariant(variant)
    api.navigation.navigate('Detail')
  }, [api])

  return (
    <Navigator>
      <SearchScreen onSelectVariant={handleSelectVariant} />
      {selectedVariant && (
        <DetailScreen variant={selectedVariant} currentLocationId={currentLocationId} />
      )}
    </Navigator>
  )
}

export default reactExtension('pos.home.modal.render', () => <Modal />)

// ─── Search Screen ────────────────────────────────────────────────────────────

function SearchScreen({ onSelectVariant }) {
  const [displayValue, setDisplayValue] = useState('')
  const [results, setResults]           = useState([])
  const [isFullMode, setIsFullMode]     = useState(false)
  const [loading, setLoading]           = useState(false)
  const [error, setError]               = useState(null)
  const [searched, setSearched]         = useState(false)

  const keywordRef = useRef('')
  const timerRef   = useRef(null)

  const runSearch = useCallback(async (kw, full) => {
    if (!kw || kw.trim().length < 2) return
    setLoading(true)
    setError(null)
    try {
      const limit = full ? 1000 : AUTO_LIMIT
      const resp = await fetch(
        `${SERVER_URL}/search?q=${encodeURIComponent(kw.trim())}&limit=${limit}`
      )
      if (!resp.ok) throw new Error(`Server error: ${resp.status}`)
      const data = await resp.json()
      const sorted = sortByPriority(data.results || [], kw.trim())
      setResults(sorted)
      setIsFullMode(full)
      setSearched(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  const handleChange = useCallback((val) => {
    keywordRef.current = val
    setDisplayValue(val)
    setIsFullMode(false)
    if (val.length < MIN_KEYWORD_LENGTH) {
      setResults([])
      setSearched(false)
    }
    if (timerRef.current) clearTimeout(timerRef.current)
    if (val.length >= MIN_KEYWORD_LENGTH) {
      timerRef.current = setTimeout(() => runSearch(val, false), DEBOUNCE_MS)
    }
  }, [runSearch])

  const handleSearch = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    runSearch(keywordRef.current, true)
  }, [runSearch])

  const charsNeeded = MIN_KEYWORD_LENGTH - displayValue.length

  return (
    <Screen name="Search" title="Search">
      <ScrollView>
        <Stack direction="vertical" spacing="base" padding="base">

          <TextField
            label="Search"
            placeholder="SKU, title, name or wig number…"
            value={displayValue}
            onChange={handleChange}
            action={{ label: 'Search', onAction: handleSearch }}
          />

          {loading && <Text color="TextSubdued">Searching…</Text>}
          {error && <Text color="TextCritical">Error: {error}</Text>}

          {!loading && displayValue.length > 0 && displayValue.length < MIN_KEYWORD_LENGTH && (
            <Text color="TextSubdued">
              {charsNeeded} more character{charsNeeded !== 1 ? 's' : ''} to auto-search
            </Text>
          )}

          {searched && !loading && results.length === 0 && (
            <Text color="TextSubdued">No variants found for "{displayValue}"</Text>
          )}

          {results.length > 0 && (
            <Text size="small" color="TextSubdued">
              {results.length} result{results.length !== 1 ? 's' : ''}
              {!isFullMode ? ' · Press Search for all results' : ''}
            </Text>
          )}

          {results.map((variant) => (
            <VariantRow
              key={variant.variantId}
              variant={variant}
              onPress={() => onSelectVariant(variant)}
            />
          ))}

        </Stack>
      </ScrollView>
    </Screen>
  )
}

// ─── Variant Row ──────────────────────────────────────────────────────────────

const SEP = ' · '

function VariantRow({ variant, onPress }) {
  // Line 1 (bold): SKU · Name
  const line1parts = []
  if (variant.sku) line1parts.push(variant.sku)
  if (variant.customName) line1parts.push(variant.customName)
  const line1 = line1parts.join(SEP)

  // Line 2: Title · Variant name
  const line2parts = [variant.productTitle]
  if (variant.variantTitle && variant.variantTitle !== 'Default Title') {
    line2parts.push(variant.variantTitle)
  }
  const line2 = line2parts.join(SEP)

  return (
    <Selectable onPress={onPress}>
      <Stack direction="inline" gap="400" alignItems="center" paddingBlock="300">
        {variant.imageUrl ? (
          <Image src={variant.imageUrl} size="s" />
        ) : null}
        <Stack direction="block" gap="100" fill>
          {line1 ? <Text fontWeight="bold">{line1}</Text> : null}
          <Text variant="captionRegular" color="TextSubdued">{line2}</Text>
        </Stack>
      </Stack>
    </Selectable>
  )
}

// ─── Detail Screen ────────────────────────────────────────────────────────────

function DetailScreen({ variant, currentLocationId }) {
  const [inventory, setInventory] = useState(null)
  const [loadingInv, setLoadingInv] = useState(true)
  const [invError, setInvError] = useState(null)

  useEffect(() => {
    setLoadingInv(true)
    setInvError(null)
    setInventory(null)
    fetch(`${SERVER_URL}/variant/${variant.variantNumericId}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) throw new Error(data.error)
        setInventory(data.locations || [])
      })
      .catch(err => setInvError(err.message))
      .finally(() => setLoadingInv(false))
  }, [variant.variantNumericId])

  const isDefault = variant.variantTitle === 'Default Title'

  const currentLoc = inventory?.find(loc => loc.locationId === currentLocationId) || null
  const otherLocs = inventory
    ? sortLocations(inventory.filter(loc => loc.locationId !== currentLocationId))
    : []

  return (
    <Screen name="Detail" title={variant.productTitle}>
      <ScrollView>
        <Stack direction="vertical" spacing="base" padding="base">

          {variant.imageUrl && <Image src={variant.imageUrl} />}

          <Text fontWeight="bold" size="large">{variant.productTitle}</Text>
          {variant.wigNumber ? <Text color="TextSubdued">{variant.wigNumber}</Text> : null}
          {!isDefault && <Text color="TextSubdued">{variant.variantTitle}</Text>}
          {variant.customName ? <Text color="TextSubdued">{variant.customName}</Text> : null}
          {variant.displaySection ? <Text color="TextSubdued">{variant.displaySection}</Text> : null}
          {variant.sku ? <Text>SKU: {variant.sku}</Text> : null}
          {variant.price != null && (
            <Text fontWeight="bold">${parseFloat(variant.price).toFixed(2)}</Text>
          )}

          <Text fontWeight="bold">Inventory by Location</Text>
          {loadingInv && <Text color="TextSubdued">Loading…</Text>}
          {invError && <Text color="TextCritical">Error: {invError}</Text>}

          {inventory && (
            <Stack direction="vertical" spacing="none">
              {currentLoc && (
                <>
                  <LocationRow loc={currentLoc} highlight />
                  <Stack paddingBlock="200" />
                </>
              )}
              {otherLocs.map((loc) => (
                <LocationRow key={loc.locationId} loc={loc} />
              ))}
            </Stack>
          )}

        </Stack>
      </ScrollView>
    </Screen>
  )
}

// ─── Location Row ─────────────────────────────────────────────────────────────

function LocationRow({ loc, highlight }) {
  const qtyText = `    ${loc.available}`
  return (
    <Text
      fontWeight={highlight ? 'bold' : 'regular'}
      color={highlight
        ? 'TextDefault'
        : loc.available > 0 ? 'TextSubdued' : 'TextCritical'
      }
    >
      {loc.locationName}{qtyText}
    </Text>
  )
}