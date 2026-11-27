// A file's bytes for a JSON body: base64, as the attach and chat routes take an image.

/** A blob's bytes as base64 (in 32 KB slices, so a 5 MB image never overflows the argument list). */
export async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
