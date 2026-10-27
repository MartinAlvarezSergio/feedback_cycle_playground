/**
 * In-place radix-2 FFT for the periodic self-gravity solve. Sizes must be powers of two.
 * `inverse` uses the conjugate twiddles and divides by n.
 */
export function fft1d(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i += 1) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/** 2D FFT of an nx × ny row-major grid (rows, then columns). */
export function fft2d(re: Float64Array, im: Float64Array, nx: number, ny: number, inverse: boolean): void {
  const rowRe = new Float64Array(nx);
  const rowIm = new Float64Array(nx);
  for (let j = 0; j < ny; j += 1) {
    const o = j * nx;
    for (let i = 0; i < nx; i += 1) {
      rowRe[i] = re[o + i];
      rowIm[i] = im[o + i];
    }
    fft1d(rowRe, rowIm, inverse);
    for (let i = 0; i < nx; i += 1) {
      re[o + i] = rowRe[i];
      im[o + i] = rowIm[i];
    }
  }
  const colRe = new Float64Array(ny);
  const colIm = new Float64Array(ny);
  for (let i = 0; i < nx; i += 1) {
    for (let j = 0; j < ny; j += 1) {
      colRe[j] = re[j * nx + i];
      colIm[j] = im[j * nx + i];
    }
    fft1d(colRe, colIm, inverse);
    for (let j = 0; j < ny; j += 1) {
      re[j * nx + i] = colRe[j];
      im[j * nx + i] = colIm[j];
    }
  }
}
