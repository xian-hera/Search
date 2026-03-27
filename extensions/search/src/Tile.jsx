import { Tile, reactExtension, useApi } from '@shopify/ui-extensions-react/point-of-sale'

const TileComponent = () => {
  const api = useApi()
  return (
    <Tile
      title="Search"
      subtitle="SKU · Barcode · Title · Name"
      onPress={() => api.action.presentModal()}
      enabled
    />
  )
}

export default reactExtension('pos.home.tile.render', () => <TileComponent />)