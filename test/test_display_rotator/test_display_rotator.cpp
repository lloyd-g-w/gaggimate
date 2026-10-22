// Unit tests: DisplayRotator arbitrary-angle resampling and touch mapping.
// Host-side, no ESP32/Arduino runtime — pio test -e native -f test_display_rotator.

#include <unity.h>

#include <cstdio>
#include <vector>

#include "display/drivers/common/DisplayRotator.h"

static constexpr int W = 480, H = 480;

static std::vector<uint16_t> pattern() {
    std::vector<uint16_t> f(W * H);
    for (int y = 0; y < H; y++)
        for (int x = 0; x < W; x++)
            f[y * W + x] = static_cast<uint16_t>((y * 131 + x * 7) & 0xFFFF) | 1; // never 0 (= background)
    return f;
}

static std::vector<uint16_t> renderFull(const DisplayRotator &r, const std::vector<uint16_t> &src) {
    std::vector<uint16_t> out(W * H);
    r.render(src.data(), 0, W - 1, 0, H, out.data(), 0);
    return out;
}

void setUp() {}
void tearDown() {}

void test_normalize() {
    TEST_ASSERT_EQUAL(0, DisplayRotator::normalizeDegrees(360));
    TEST_ASSERT_EQUAL(270, DisplayRotator::normalizeDegrees(-90));
    TEST_ASSERT_EQUAL(15, DisplayRotator::normalizeDegrees(375));
}

void test_zero_is_identity() {
    DisplayRotator r;
    r.configure(W, H, 0);
    const auto src = pattern();
    TEST_ASSERT_TRUE(renderFull(r, src) == src);
}

void test_quarter_turns_are_exact() {
    const auto src = pattern();
    for (int deg : {90, 180, 270}) {
        DisplayRotator r;
        r.configure(W, H, deg);
        const auto out = renderFull(r, src);
        for (int y = 0; y < H; y++) {
            for (int x = 0; x < W; x++) {
                int sx, sy; // expected logical source of physical (x, y), clockwise rotation
                if (deg == 90)
                    sx = y, sy = W - 1 - x;
                else if (deg == 180)
                    sx = W - 1 - x, sy = H - 1 - y;
                else
                    sx = H - 1 - y, sy = x;
                if (out[y * W + x] != src[sy * W + sx]) {
                    char msg[64];
                    snprintf(msg, sizeof msg, "deg %d at (%d,%d)", deg, x, y);
                    TEST_FAIL_MESSAGE(msg);
                }
            }
        }
    }
}

void test_90_turns_top_left_to_top_right() {
    DisplayRotator r;
    r.configure(W, H, 90);
    double px, py;
    r.logicalToPhysical(0, 0, px, py);
    TEST_ASSERT_EQUAL(W - 1, lround(px));
    TEST_ASSERT_EQUAL(0, lround(py));
}

void test_arbitrary_angle_keeps_circle_and_blanks_corners() {
    const auto src = pattern();
    DisplayRotator r;
    r.configure(W, H, 37);
    const auto out = renderFull(r, src);
    // Physical corners map outside the logical square -> background.
    TEST_ASSERT_EQUAL_HEX16(0, out[0]);
    TEST_ASSERT_EQUAL_HEX16(0, out[W - 1]);
    TEST_ASSERT_EQUAL_HEX16(0, out[(H - 1) * W]);
    // Everything inside the inscribed circle is covered by real pixels.
    const double c = (W - 1) / 2.0, rad = W / 2.0 - 1;
    for (int y = 0; y < H; y++)
        for (int x = 0; x < W; x++)
            if ((x - c) * (x - c) + (y - c) * (y - c) <= rad * rad)
                TEST_ASSERT_NOT_EQUAL(0, out[y * W + x]);
    // Each pixel comes from the nearest logical pixel under the inverse map
    // (give or take one where fixed-point and double rounding straddle .5).
    int exact = 0, total = 0;
    for (int y = 0; y < H; y += 7) {
        for (int x = 0; x < W; x += 5) {
            int16_t lx, ly;
            r.physicalToLogical(x, y, lx, ly);
            const uint16_t v = out[y * W + x];
            if (v == 0)
                continue;
            total++;
            bool near = false;
            for (int oy = -1; oy <= 1; oy++)
                for (int ox = -1; ox <= 1; ox++) {
                    const int sx = lx + ox, sy = ly + oy;
                    if (sx >= 0 && sx < W && sy >= 0 && sy < H && src[sy * W + sx] == v)
                        near = true;
                }
            TEST_ASSERT_TRUE(near);
            exact += src[ly * W + lx] == v;
        }
    }
    TEST_ASSERT_TRUE(exact * 100 >= total * 99);
}

void test_touch_round_trip() {
    for (int deg : {0, 15, 90, 123, 180, 270, 359}) {
        DisplayRotator r;
        r.configure(W, H, deg);
        for (int i = 0; i < 50; i++) {
            const double lx = 120 + i * 4.3, ly = 300 - i * 3.1; // inside the circle
            double px, py;
            r.logicalToPhysical(lx, ly, px, py);
            int16_t bx, by;
            r.physicalToLogical(static_cast<int16_t>(lround(px)), static_cast<int16_t>(lround(py)), bx, by);
            TEST_ASSERT_INT_WITHIN(1, lround(lx), bx);
            TEST_ASSERT_INT_WITHIN(1, lround(ly), by);
        }
    }
}

void test_bounds_cover_every_changed_pixel() {
    // Changing a logical area must only affect physical pixels inside physicalBounds().
    const auto src = pattern();
    for (int deg : {10, 45, 90, 200, 333}) {
        DisplayRotator r;
        r.configure(W, H, deg);
        const RotatorArea area{100, 150, 180, 170};
        auto changed = src;
        for (int y = area.y1; y <= area.y2; y++)
            for (int x = area.x1; x <= area.x2; x++)
                changed[y * W + x] ^= 0x8000;
        const auto before = renderFull(r, src), after = renderFull(r, changed);
        RotatorArea b;
        TEST_ASSERT_TRUE(r.physicalBounds(area, b));
        for (int y = 0; y < H; y++)
            for (int x = 0; x < W; x++)
                if (before[y * W + x] != after[y * W + x]) {
                    TEST_ASSERT_TRUE(x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2);
                }
    }
}

void test_partial_render_matches_full() {
    const auto src = pattern();
    DisplayRotator r;
    r.configure(W, H, 73);
    const auto full = renderFull(r, src);
    std::vector<uint16_t> strip(61 * 13);
    r.render(src.data(), 200, 260, 100, 13, strip.data(), 0);
    for (int y = 0; y < 13; y++)
        for (int x = 0; x < 61; x++)
            TEST_ASSERT_EQUAL_HEX16(full[(100 + y) * W + 200 + x], strip[y * 61 + x]);
}

int main(int, char **) {
    UNITY_BEGIN();
    RUN_TEST(test_normalize);
    RUN_TEST(test_zero_is_identity);
    RUN_TEST(test_quarter_turns_are_exact);
    RUN_TEST(test_90_turns_top_left_to_top_right);
    RUN_TEST(test_arbitrary_angle_keeps_circle_and_blanks_corners);
    RUN_TEST(test_touch_round_trip);
    RUN_TEST(test_bounds_cover_every_changed_pixel);
    RUN_TEST(test_partial_render_matches_full);
    return UNITY_END();
}
