var supportedWasm = (() => {
    try {
        if (typeof WebAssembly === "object"
            && typeof WebAssembly.instantiate === "function") {
            const module = new WebAssembly.Module(Uint8Array.of(0x0, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00));
            if (module instanceof WebAssembly.Module)
                return new WebAssembly.Instance(module) instanceof WebAssembly.Instance;
        }
    } catch (e) {
    }
    return false;
})();
importScripts(supportedWasm ? 'ff_wasm.js' : 'ff.js')
importScripts('webgl.js')
function arrayBufferCopy(src, dst, dstByteOffset, numBytes) {
    var i;
    var dst32Offset = dstByteOffset / 4;
    var tail = (numBytes % 4);
    var src32 = new Uint32Array(src.buffer, 0, (numBytes - tail) / 4);
    var dst32 = new Uint32Array(dst.buffer);
    for (i = 0; i < src32.length; i++) {
        dst32[dst32Offset + i] = src32[i];
    }
    for (i = numBytes - tail; i < numBytes; i++) {
        dst[dstByteOffset + i] = src[i];
    }
}
function dispatchData(input) {
    let need = input.next()
    let buffer = null
    return (value) => {
        var data = new Uint8Array(value)
        if (buffer) {
            var combine = new Uint8Array(buffer.length + data.length)
            combine.set(buffer)
            combine.set(data, buffer.length)
            data = combine
            buffer=null
        }
        while (data.length >= need.value) {
            var remain = data.slice(need.value)
            need = input.next(need.value > 1 ? data.slice(0, need.value) : data[0])
            data = remain
        }
        if (data.length > 0) {
            buffer = data
        }
    }
}
if (!Date.now) Date.now = function () {
    return new Date().getTime();
};
Module.print = function (text) {
    postMessage({ cmd: "print", text: text })
}
Module.printErr = function (text) {
    postMessage({ cmd: "printErr", text: text })
}
Module.postRun = function () {
    var decoder = {
        opt: {},
        initAudioPlanar: function (channels, samplerate) {
            var buffersA = [];
            for (var i = 0; i < channels; i++) {
                buffersA.push([]);
            }
            postMessage({ cmd: "initAudioPlanar", samplerate: samplerate, channels: channels })
            this.playAudioPlanar = function (data, len, ts) {
                var outputArray = [];
                var frameCount = len / 4 / buffersA.length;
                for (var i = 0; i < buffersA.length; i++) {
                    var fp = HEAPU32[(data >> 2) + i] >> 2;
                    var float32 = HEAPF32.subarray(fp, fp + frameCount);
                    var buffer = buffersA[i]
                    if (buffer.length) {
                        buffer = buffer.pop();
                        for (var j = 0; j < buffer.length; j++) {
                            buffer[j] = float32[j];
                        }
                    } else {
                        buffer = Float32Array.from(float32);
                    }
                    outputArray[i] = buffer;
                }
                postMessage({ cmd: "playAudio", buffer: outputArray, ts: ts }, outputArray.map(x => x.buffer))
            }
        },
        inputFlv: function* () {
            yield 13
            var tmp = new ArrayBuffer(4)
            var tmp8 = new Uint8Array(tmp)
            var tmp32 = new Uint32Array(tmp)
            while (true) {
                var type = yield 1
                tmp8.set((yield 3).reverse())
                var length = tmp32[0]
                tmp8.set((yield 3).reverse())
                var ts = tmp32[0]
                yield 4
                var payload = yield length
                switch (type) {
                    case 8:
                        audioDecoder.decode(payload)
                        break
                    case 9:
                        videoDecoder.decode(payload)
                        break
                }
                yield 4
            }
        },
        play: function (url) {
            console.log('Jessibuca play', url)
            this.getDelay = function (timestamp) {
                this.firstVideoTimestamp = timestamp
                this.firstTimestamp = Date.now()
                this.getDelay = function (timestamp) {
                    this.delay = (timestamp - this.firstVideoTimestamp) - (Date.now() - this.firstTimestamp)
                    return this.delay
                }
                return 0
            }
            if (url.indexOf("http") == 0) {
                this.flvMode = true
                var _this = this;
                this.controller = new AbortController();
                fetch(url, { signal: this.controller.signal }).then(function (res) {
                    var reader = res.body.getReader();
                    var dispatch = dispatchData(_this.inputFlv())
                    var fetchNext = function () {
                        reader.read().then(({ done, value }) => {
                            if (done) {
                                _this.close()
                            } else {
                                dispatch(value)
                                fetchNext()
                            }
                        }).catch((e) => dispatch.return(e))
                    }
                    fetchNext()
                }).catch(console.error)
                this.close = function () {
                    this.controller.abort();
                    delete this.close
                }
            } else {
                this.flvMode = url.indexOf(".flv") != -1
                this.ws = new WebSocket(url)
                this.ws.binaryType = "arraybuffer"
                if (this.flvMode) {
                    var dispatch = dispatchData(this.inputFlv())
                    this.ws.onmessage = evt => dispatch(evt.data)
                } else {
                    this.ws.onmessage = evt => {
                        var dv = new DataView(evt.data)
                        switch (dv.getUint8(0)) {
                            case 1:
                                var ts = dv.getUint32(1, false)
                                audioDecoder.decode(new Uint8Array(data, 5))
                                break
                            case 2:
                                var ts = dv.getUint32(1, false)
                                videoDecoder.decode(new Uint8Array(data, 5))
                                break
                        }
                    }
                }
                this.close = function () {
                    this.ws.close()
                    delete this.close
                }
            }
            this.setVideoSize = function (w, h) {
                postMessage({ cmd: "initSize", w: w, h: h })
                var size = w * h
                var qsize = size >> 2
                if (!this.opt.forceNoOffscreen && typeof OffscreenCanvas != 'undefined') {
                    var canvas = new OffscreenCanvas(w, h);
                    var gl = canvas.getContext("webgl");
                    var render = createWebGL(gl)
                    this.draw = function (compositionTime, ts, y, u, v) {
                        render(w, h, HEAPU8.subarray(y, y + size), HEAPU8.subarray(u, u + qsize), HEAPU8.subarray(v, v + (qsize)))
                        let image_bitmap = canvas.transferToImageBitmap();
                        postMessage({ cmd: "render", compositionTime: compositionTime, ts: ts, bps: this.bps, delay: this.delay, buffer: image_bitmap }, [image_bitmap])
                    }
                } else {
                    this.draw = function (compositionTime, ts, y, u, v) {
                        var yuv = [HEAPU8.subarray(y, y + size), HEAPU8.subarray(u, u + qsize), HEAPU8.subarray(v, v + (qsize))];
                        var outputArray = yuv.map(buffer => Uint8Array.from(buffer))
                        // arrayBufferCopy(HEAPU8.subarray(y, y + size), this.sharedBuffer, 0, size)
                        // arrayBufferCopy(HEAPU8.subarray(u, u + (qsize)), this.sharedBuffer, size, qsize)
                        // arrayBufferCopy(HEAPU8.subarray(v, v + (qsize)), this.sharedBuffer, size + qsize, qsize)
                        postMessage({ cmd: "render", compositionTime: compositionTime, ts: ts, bps: this.bps, delay: this.delay, output: outputArray }, outputArray.map(x => x.buffer))
                    }
                }
            }
        },
    }
    var audioDecoder = new Module.AudioDecoder(decoder)
    var videoDecoder = new Module.VideoDecoder(decoder)
    postMessage({ cmd: "init" })
    self.onmessage = function (event) {
        var msg = event.data
        switch (msg.cmd) {
            case "init":
                decoder.opt = msg.opt
                break
            case "getProp":
                postMessage({ cmd: "getProp", value: decoder[msg.prop] })
                break
            case "setProp":
                decoder[msg.prop] = msg.value
                break
            case "play":
                decoder.play(msg.url)
                break
            case "setVideoBuffer":
                decoder.videoBuffer = (msg.time * 1000) | 0
                break
            case "close":
                if (decoder.close) decoder.close()
                break
        }
    }
}