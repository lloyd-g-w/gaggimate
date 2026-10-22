#pragma once

// Arbitrary-angle software rotation of the whole display about its centre.
//
// LVGL 8 can only rotate by 90-degree steps, so for any other angle the flush
// path keeps an unrotated "logical" frame (what LVGL drew) and resamples it into
// the physical panel orientation with nearest-neighbour sampling. Positive
// angles turn the picture clockwise as seen on the panel. On round panels the
// rotation is lossless apart from resampling; on square panels the logical
// corners fall off the glass and the uncovered physical corners are filled
// with the background colour.
//
// Header-only and free of Arduino/LVGL dependencies so it can be unit-tested
// on the host (pio test -e native -f test_display_rotator).

#include <math.h>
#include <stdint.h>

struct RotatorArea {
    int16_t x1, y1, x2, y2; // inclusive, like lv_area_t
};

class DisplayRotator {
  public:
    static int normalizeDegrees(int degrees) {
        degrees %= 360;
        return degrees < 0 ? degrees + 360 : degrees;
    }

    void configure(int16_t width, int16_t height, int degrees) {
        _w = width;
        _h = height;
        _deg = normalizeDegrees(degrees);
        // Exact values on the quarter turns so 90/180/270 map pixel-for-pixel.
        switch (_deg) {
        case 0:
            _cos = 1.0, _sin = 0.0;
            break;
        case 90:
            _cos = 0.0, _sin = 1.0;
            break;
        case 180:
            _cos = -1.0, _sin = 0.0;
            break;
        case 270:
            _cos = 0.0, _sin = -1.0;
            break;
        default: {
            const double rad = _deg * M_PI / 180.0;
            _cos = cos(rad);
            _sin = sin(rad);
        }
        }
        _cosF = static_cast<int32_t>(lround(_cos * 65536.0));
        _sinF = static_cast<int32_t>(lround(_sin * 65536.0));
        _cx = (width - 1) / 2.0;
        _cy = (height - 1) / 2.0;
    }

    int angle() const { return _deg; }
    bool active() const { return _deg != 0; }

    // Physical (panel/touch) point -> logical (LVGL) point, clamped to the screen.
    void physicalToLogical(int16_t px, int16_t py, int16_t &lx, int16_t &ly) const {
        const double dx = px - _cx, dy = py - _cy;
        lx = clamp(lround(_cx + _cos * dx + _sin * dy), _w - 1);
        ly = clamp(lround(_cy - _sin * dx + _cos * dy), _h - 1);
    }

    // Logical point -> physical point (inverse of physicalToLogical, unclamped).
    void logicalToPhysical(double lx, double ly, double &px, double &py) const {
        const double dx = lx - _cx, dy = ly - _cy;
        px = _cx + _cos * dx - _sin * dy;
        py = _cy + _sin * dx + _cos * dy;
    }

    // Physical bounding box that a changed logical area lands in, clipped to the
    // screen. Returns false if it falls completely off the panel.
    bool physicalBounds(const RotatorArea &logical, RotatorArea &out) const {
        double minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
        const double xs[2] = {logical.x1 - 0.5, logical.x2 + 0.5};
        const double ys[2] = {logical.y1 - 0.5, logical.y2 + 0.5};
        for (double x : xs) {
            for (double y : ys) {
                double px, py;
                logicalToPhysical(x, y, px, py);
                minX = fmin(minX, px), maxX = fmax(maxX, px);
                minY = fmin(minY, py), maxY = fmax(maxY, py);
            }
        }
        // One pixel of slack covers nearest-neighbour rounding at the edges.
        int32_t x1 = static_cast<int32_t>(floor(minX)) - 1, y1 = static_cast<int32_t>(floor(minY)) - 1;
        int32_t x2 = static_cast<int32_t>(ceil(maxX)) + 1, y2 = static_cast<int32_t>(ceil(maxY)) + 1;
        if (x1 < 0)
            x1 = 0;
        if (y1 < 0)
            y1 = 0;
        if (x2 > _w - 1)
            x2 = _w - 1;
        if (y2 > _h - 1)
            y2 = _h - 1;
        if (x1 > x2 || y1 > y2)
            return false;
        out = {static_cast<int16_t>(x1), static_cast<int16_t>(y1), static_cast<int16_t>(x2), static_cast<int16_t>(y2)};
        return true;
    }

    // Fill `rows` physical rows starting at y0, covering columns x1..x2 of the
    // physical area, into `out` (packed, (x2-x1+1) pixels per row). `src` is the
    // full logical frame (stride = width). Pixels whose source is off-screen get
    // `background`.
    void render(const uint16_t *src, int16_t x1, int16_t x2, int16_t y0, int16_t rows, uint16_t *out, uint16_t background) const {
        const int32_t half = 1 << 15;
        // 16.16 fixed point; (cx, cy) are multiples of 0.5 so they are exact.
        const int32_t cxF = static_cast<int32_t>(_cx * 65536.0), cyF = static_cast<int32_t>(_cy * 65536.0);
        const uint32_t w = static_cast<uint32_t>(_w), h = static_cast<uint32_t>(_h);
        for (int16_t r = 0; r < rows; r++) {
            const int32_t dy = static_cast<int32_t>(y0 + r) * 65536 - cyF;
            const int32_t dx = static_cast<int32_t>(x1) * 65536 - cxF;
            // sx = cx + cos*dx + sin*dy ; sy = cy - sin*dx + cos*dy  (64-bit for the products)
            int32_t sx =
                cxF + static_cast<int32_t>((static_cast<int64_t>(_cosF) * dx + static_cast<int64_t>(_sinF) * dy) >> 16) + half;
            int32_t sy =
                cyF + static_cast<int32_t>((static_cast<int64_t>(_cosF) * dy - static_cast<int64_t>(_sinF) * dx) >> 16) + half;
            for (int16_t x = x1; x <= x2; x++) {
                const uint32_t ix = static_cast<uint32_t>(sx >> 16), iy = static_cast<uint32_t>(sy >> 16);
                *out++ = (ix < w && iy < h) ? src[iy * w + ix] : background; // unsigned compare also rejects < 0
                sx += _cosF;
                sy -= _sinF;
            }
        }
    }

  private:
    static int16_t clamp(long v, int max) { return static_cast<int16_t>(v < 0 ? 0 : (v > max ? max : v)); }

    int16_t _w = 0, _h = 0;
    int _deg = 0;
    double _cos = 1.0, _sin = 0.0, _cx = 0.0, _cy = 0.0;
    int32_t _cosF = 65536, _sinF = 0;
};
