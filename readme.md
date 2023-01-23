# Vector Tile Transformer

Vector Tile Transformer lets you change [Vector Tiles](https://github.com/mapbox/vector-tile-spec) in a stream.

## API

### `stream = vtt(function(data, fn){ /* ... */ })`

A transform stream passing the unpacked vector tile data to a function for modification.

#### Example

``` js

const fs = require("fs");

const src = fs.createReadStream("tile-in.pbf");
const dest = fs.createWriteStream("tile-out.pbf");

const vtt = require("vtt");

src.pipe(vtt(function(layers, done){
	
	// filter layers by name
	layers = layers.filter(function(layer){
		return (layer.name !== "keepme");
	});
	
	// add a property to all features in a layer
	layers[0] = layers[0].map(function(feature){
		feature.properties.modified = true;
		return feature;
	});
	
	done(null, layers); // err, data
	
})).pipe(dest);

```

#### `data`

``` js

[{
	version: 2,
	name: "name",
	extent: 4096,
	features: [{
		id: 1,
		type: 1,
		properties: {
			key: "value",
		},
		geometry: (...geometry),
	}],
}]

```


### `data = vtt.unpack(buffer);`

Sync convenience method to turn an uncompressed vector tile into an object

### `buffer = vtt.pack(data);`

Sync convenience method to turn an object back into an uncompressed vector tile

## License

[UNLICENSE](https://unlicense.org/)
