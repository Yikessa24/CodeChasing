function valuesFrom(init) {
  if (!init) {
    return [1, 0, 0, 1, 0, 0];
  }
  if (Array.isArray(init) || ArrayBuffer.isView(init)) {
    if (init.length === 6) {
      return Array.from(init, Number);
    }
    if (init.length === 16) {
      return [init[0], init[1], init[4], init[5], init[12], init[13]].map(Number);
    }
  }
  if (typeof init === 'object') {
    return ['a', 'b', 'c', 'd', 'e', 'f'].map((key, index) =>
      Number(init[key] ?? [1, 0, 0, 1, 0, 0][index])
    );
  }
  throw new TypeError('DOMMatrix initialization must be a 6-value matrix.');
}

function product(left, right) {
  return [
    left.a * right.a + left.c * right.b,
    left.b * right.a + left.d * right.b,
    left.a * right.c + left.c * right.d,
    left.b * right.c + left.d * right.d,
    left.a * right.e + left.c * right.f + left.e,
    left.b * right.e + left.d * right.f + left.f
  ];
}

export class DOMMatrixPolyfill {
  constructor(init) {
    [this.a, this.b, this.c, this.d, this.e, this.f] = valuesFrom(init);
  }

  get is2D() {
    return true;
  }

  get isIdentity() {
    return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
  }

  multiplySelf(other) {
    [this.a, this.b, this.c, this.d, this.e, this.f] = product(
      this,
      new DOMMatrixPolyfill(other)
    );
    return this;
  }

  preMultiplySelf(other) {
    [this.a, this.b, this.c, this.d, this.e, this.f] = product(
      new DOMMatrixPolyfill(other),
      this
    );
    return this;
  }

  multiply(other) {
    return new DOMMatrixPolyfill(this).multiplySelf(other);
  }

  translateSelf(x = 0, y = 0) {
    return this.multiplySelf([1, 0, 0, 1, Number(x), Number(y)]);
  }

  translate(x = 0, y = 0) {
    return new DOMMatrixPolyfill(this).translateSelf(x, y);
  }

  scaleSelf(x = 1, y = x, _z = 1, originX = 0, originY = 0) {
    if (originX || originY) {
      this.translateSelf(originX, originY);
    }
    this.multiplySelf([Number(x), 0, 0, Number(y), 0, 0]);
    if (originX || originY) {
      this.translateSelf(-originX, -originY);
    }
    return this;
  }

  scale(x = 1, y = x, z = 1, originX = 0, originY = 0) {
    return new DOMMatrixPolyfill(this).scaleSelf(x, y, z, originX, originY);
  }

  rotateSelf(angle = 0) {
    const radians = (Number(angle) * Math.PI) / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    return this.multiplySelf([cosine, sine, -sine, cosine, 0, 0]);
  }

  rotate(angle = 0) {
    return new DOMMatrixPolyfill(this).rotateSelf(angle);
  }

  invertSelf() {
    const determinant = this.a * this.d - this.b * this.c;
    if (!determinant) {
      this.a = this.b = this.c = this.d = this.e = this.f = Number.NaN;
      return this;
    }
    const { a, b, c, d, e, f } = this;
    this.a = d / determinant;
    this.b = -b / determinant;
    this.c = -c / determinant;
    this.d = a / determinant;
    this.e = (c * f - d * e) / determinant;
    this.f = (b * e - a * f) / determinant;
    return this;
  }

  inverse() {
    return new DOMMatrixPolyfill(this).invertSelf();
  }

  transformPoint(point = {}) {
    const x = Number(point.x ?? 0);
    const y = Number(point.y ?? 0);
    return {
      x: this.a * x + this.c * y + this.e,
      y: this.b * x + this.d * y + this.f,
      z: Number(point.z ?? 0),
      w: Number(point.w ?? 1)
    };
  }

  toFloat32Array() {
    return new Float32Array([
      this.a, this.b, 0, 0,
      this.c, this.d, 0, 0,
      0, 0, 1, 0,
      this.e, this.f, 0, 1
    ]);
  }
}

if (!globalThis.DOMMatrix) {
  globalThis.DOMMatrix = DOMMatrixPolyfill;
}

if (!globalThis.navigator) {
  const platform =
    typeof process === 'object'
      ? process.platform === 'darwin'
        ? 'MacIntel'
        : process.platform === 'win32'
          ? 'Win32'
          : 'Linux x86_64'
      : '';
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      language: 'en-US',
      languages: ['en-US'],
      platform,
      userAgent: typeof process === 'object' ? `Node.js/${process.version}` : 'PDF.js worker'
    },
    configurable: true,
    enumerable: true
  });
}
