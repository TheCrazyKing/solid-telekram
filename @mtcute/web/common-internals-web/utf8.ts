const sharedEncoder = new TextEncoder()
const sharedDecoder = new TextDecoder('utf8')

export function utf8ByteLength(str: string): number {
    // https://stackoverflow.com/a/23329386
    let s = str.length

    for (let i = str.length - 1; i >= 0; i--) {
        const code = str.charCodeAt(i)
        if (code > 0x7f && code <= 0x7ff) s++
        else if (code > 0x7ff && code <= 0xffff) s += 2
        if (code >= 0xdc00 && code <= 0xdfff) i-- //trail surrogate
    }

    return s
}

export function utf8Decode(buf: Uint8Array): string {
    return sharedDecoder.decode(buf)
}

export function utf8Encode(str: string): Uint8Array {
    return sharedEncoder.encode(str)
}
