const pbf = require("pbf");
const stream = require("stream");

const vtt = module.exports = function vtt(){
	if (!(this instanceof vtt)) return new vtt(...arguments);
	const fn = Array.from(arguments).find(function(arg){ return (typeof arg === "function") });
	// data = args.find(function(arg){ return (typeof arg === "object" && Buffer.isBuffer(arg)) });

	let buf = [];
	return new stream.Transform({
		transform: function(chunk, encoding, done) {
			buf.push(chunk);
			done();
		},
		flush: function(done) {
			const s = this;
			if (!fn) return s.emit("error", new Error("Missing Modify Function")), done();
			fn(unpack(Buffer.concat(buf)), function(err, data){ // FIXME error?
				if (err) return s.emit("error", new Error(err)), done();
				s.emit("data", pack(data)), done();
			});
		}
	});

};

const unpack = module.exports.unpack = function unpack(buf){
	return (new pbf(buf)).readFields(function(tag, layers, pb){
		if (tag === 0x3) {
			
			const layer = {
				version: 1,
				name: null,
				extent: 4096,
				features: [],
				keys: [],
				values: [],
			};

			pb.readFields(function(tag, l, pb) {
				switch (tag) {
					case 0xf: l.version = pb.readVarint(); break;
					case 0x1: l.name = pb.readString(); break;
					case 0x5: l.extent = pb.readVarint(); break;
					case 0x2: 
						const feature = { type: 0, properties: [], geometry: -1 };
						pb.readFields(function(tag, f, pb) {
							let end;
							switch (tag) {
								case 0x1: f.id = pb.readVarint(); break;
								case 0x3: f.type = pb.readVarint(); break;
								case 0x2: // read properties
									end = pb.readVarint() + pb.pos;
									while (pb.pos < end) f.properties.push([ pb.readVarint(), pb.readVarint() ]);
								break;
								case 0x4: // read geometry
									f.geometry = [];
									end = pb.readVarint() + pb.pos;
									let cmd = 1;
									let len = 0;
									let x = 0;
									let y = 0;
									let ring = [];
									let inst;
									while (pb.pos < end) {
										if (len-- <= 0) inst = pb.readVarint(), cmd = inst & 0x7, len = (inst >> 3) - 1;
										switch (cmd) {
											case 0x1: // moveto; new ring
												if (ring.length > 0) f.geometry.push(ring), ring = [];
												case 0x2: // lineto, fill ring
												ring.push([ x += pb.readSVarint(), y += pb.readSVarint() ]);
											break;
											case 0x7: // close, close polygon
												if (ring.length > 0) ring.push([ ring[0][0], ring[0][1] ]); // close polygon
											break;
											default:
												throw new Error("unknown command "+cmd);
											break;
										}
									}
									if (ring.length > 0) f.geometry.push(ring);
								break;
							}
						}, feature, pb.readVarint()+pb.pos);
						l.features.push(feature);
					break;
					case 0x3: l.keys.push(pb.readString()); break;
					case 0x4: 
						let end = (pb.readVarint()+pb.pos);
						while (pb.pos < end) {
							switch (pb.readVarint() >> 3) {
								case 0x1: l.values.push(pb.readString()); break;
								case 0x2: l.values.push(pb.readFloat()); break;
								case 0x3: l.values.push(pb.readDouble()); break;
								case 0x4: l.values.push(pb.readVarint64()); break; // deprecated
								case 0x5: l.values.push(pb.readVarint()); break;
								case 0x6: l.values.push(pb.readSVarint()); break;
								case 0x7: l.values.push(pb.readBoolean()); break;
							};
						};
					break;
				};
			}, layer, pb.readVarint()+pb.pos);

			// map keys and values
			layer.features = layer.features.map(function(f){
				return f.properties = f.properties.reduce(function(p,v){
					return p[layer.keys[v[0]]]=layer.values[v[1]],p;
				},{}), f;
			});
			
			layers.push(layer);
		}
			
	}, []);
};

const pack = module.exports.pack = function js2pbf(tile){

	const pb = new pbf();

	tile.map(function(layer){
		
		// destruct properties
		const keys = {};
		const values = {};
		let kidx = 0;
		let vidx = 0;
		
		layer.features = layer.features.map(function(feature){
			
			feature.properties = Object.entries(feature.properties).filter(function([ k, v ]){
				return (v === null || typeof v !== undefined);
			}).map(function([ k, v ]){

				// create a unique string for value, good enough™
				const vk = (typeof v)+":"+v.toString();

				if (!keys.hasOwnProperty(k)) keys[k] = kidx++;
				if (!values.hasOwnProperty(vk)) values[vk] = [ vidx++, v ];
				return [ keys[k], values[vk][0] ];
				
			});
			
			return feature;
			
		});
		
		// flatten keys and values
		layer.keys = Object.entries(keys).reduce(function(l, [ k, v ]){ return l[v]=k,l },[]);
		layer.values = Object.entries(values).reduce(function(l, [ k, v ]){ return l[v[0]]=v[1],l },[]);
		
		return layer;
		
	}).forEach(function(layer){
			
		// construct protobuf
		pb.writeMessage(3, function(l, p){
			
			// write version, name and extent
			pb.writeVarintField(15, layer.version || 1);
			pb.writeStringField(1, layer.name || "");
			pb.writeVarintField(5, layer.extent || 4096);
			
			// write keys
			layer.keys.forEach(function(k){
				pb.writeStringField(3, k);
			});

			// write values
			layer.values.forEach(function(v){
				pb.writeMessage(4, function(v, pb){
					switch (typeof v) {
						case "string": pb.writeStringField(1, v); break;
						case "boolean": pb.writeBooleanField(7, v); break;
						case "number":
							if (v % 1 !== 0) return pb.writeDoubleField(3, v); // in js all floats are doubles regardless
							if (v < 0) return pb.writeSVarintField(6, v);
							pb.writeVarintField(5, v);
						break;
						case "bigint":
							pb.writeVarintField(4, v);
						break;
						default:
							throw new Error("Property value has invalid type: "+(typeof v));
						break;
					}
				}, v);
				
			});

			// write features
			layer.features.forEach(function(feature){
				
				// write feature
				pb.writeMessage(2, function(){

					// write id and type
					if (feature.id !== undefined) pb.writeVarintField(1, feature.id);
					pb.writeVarintField(3, feature.type);

					// write properties
					pb.writeMessage(2, function(properties,pb){
						feature.properties.forEach(function(property){
							pb.writeVarint(property[0]); // key-id
							pb.writeVarint(property[1]); // value-id
						});
					}, feature.properties);
					
					// write geometry — https://github.com/mapbox/vector-tile-spec/blob/master/2.1/README.md#43-geometry-encoding
					pb.writeMessage(4, function(feature, pb){
						let x = 0, y = 0;
						feature.geometry.forEach(function(ring){
							let dx = 0, dy = 0;
							// write length 1 and MoveTo first coordinate pair

							pb.writeVarint((1<<3)+0x1);
							pb.writeSVarint(dx = ring[0][0] - x);
							pb.writeSVarint(dy = ring[0][1] - y);
							if (feature.type > 0x1) { // only lines and polygons
								let len = ring.length+2-feature.type; // omit last coordinate pair for polygons
								pb.writeVarint(((len-1)<<3)+0x2); // length (without first element) and LineTo
								for (let i = 1; i < len; i++) { // write remaining coordinates, start with second coordinate
									pb.writeSVarint(dx = ring[i][0] - (x += dx));
									pb.writeSVarint(dy = ring[i][1] - (y += dy));
								};
								// in case of more rings:
								x += dx, y += dy;
							};
							if (feature.type === 0x3) pb.writeVarint((1<<3)+0x7); // ClosePath for polygons
						});
					}, feature);
				}, feature);
			});
		}, layer);
	});
	
	return pb.finish();

};
