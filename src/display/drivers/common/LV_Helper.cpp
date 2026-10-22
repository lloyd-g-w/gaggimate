/**
 * @file      LV_Helper.cpp
 * @author    Lewis He (lewishe@outlook.com)
 * @license   MIT
 * @copyright Copyright (c) 2024  Shenzhen Xin Yuan Electronic Technology Co.,
 * Ltd
 * @date      2024-01-22
 *
 */
#include "LV_Helper.h"
#include "DisplayRotator.h"

#if LV_VERSION_CHECK(9, 0, 0)
#error "Currently not supported 9.x"
#endif

static lv_disp_draw_buf_t draw_buf;
static lv_disp_drv_t disp_drv;
static lv_indev_drv_t indev_drv;
static lv_color_t *buf = NULL;
static lv_color_t *buf1 = NULL;

// Arbitrary-angle rotation (see DisplayRotator.h). Only used for angles LVGL's
// own sw_rotate can't do; `logical_frame` mirrors what LVGL drew (in direct
// mode LVGL's buffer already is that frame), `rotate_strip` is the scratch the
// resampled rows are pushed from.
static DisplayRotator rotator;
static bool custom_rotation = false;
static uint16_t *logical_frame = NULL;
static uint16_t *rotate_strip = NULL;
static constexpr int16_t ROTATE_STRIP_ROWS = 40;

// Resample one changed logical area into the panel. Display::pushColors has two
// conventions: partial-mode RGB panels take exclusive end coordinates (as
// esp_lcd_panel_draw_bitmap does), the direct-mode AMOLED takes width/height.
static void rotate_area(Display *board, const uint16_t *src, const lv_area_t *area) {
    RotatorArea phys;
    if (!rotator.physicalBounds({area->x1, area->y1, area->x2, area->y2}, phys))
        return;
    // Even-aligned windows: AMOLED controllers (CO5300 etc.) reject odd starts/sizes.
    phys.x1 &= ~1;
    phys.y1 &= ~1;
    if (phys.x2 < board->width() - 1)
        phys.x2 |= 1;
    if (phys.y2 < board->height() - 1)
        phys.y2 |= 1;
    const int16_t physW = phys.x2 - phys.x1 + 1;
    const bool direct = board->supportsDirectMode();
    for (int16_t y = phys.y1; y <= phys.y2; y += ROTATE_STRIP_ROWS) {
        const int16_t rows = (phys.y2 - y + 1) < ROTATE_STRIP_ROWS ? (phys.y2 - y + 1) : ROTATE_STRIP_ROWS;
        rotator.render(src, phys.x1, phys.x2, y, rows, rotate_strip, 0x0000);
        if (direct)
            board->pushColors(phys.x1, y, physW, rows, rotate_strip);
        else
            board->pushColors(phys.x1, y, phys.x1 + physW, y + rows, rotate_strip);
    }
}

static void rotated_flush(lv_disp_drv_t *drv, const lv_area_t *area, lv_color_t *color_p) {
    Display *board = static_cast<Display *>(drv->user_data);
    if (board->supportsDirectMode()) {
        // Direct mode hands over the whole frame once per dirty area; resample
        // the dirty areas themselves once the last one is drawn.
        if (!lv_disp_flush_is_last(drv))
            return;
        lv_disp_t *disp = _lv_refr_get_disp_refreshing();
        const uint16_t *src = reinterpret_cast<uint16_t *>(color_p);
        for (uint16_t i = 0; i < disp->inv_p; i++) {
            if (!disp->inv_area_joined[i])
                rotate_area(board, src, &disp->inv_areas[i]);
        }
        return;
    }
    // Partial mode: color_p holds just this area; fold it into the full logical frame.
    const int16_t w = board->width();
    const int16_t areaW = area->x2 - area->x1 + 1;
    const uint16_t *row = reinterpret_cast<uint16_t *>(color_p);
    for (int16_t y = area->y1; y <= area->y2; y++, row += areaW)
        memcpy(logical_frame + y * w + area->x1, row, areaW * sizeof(uint16_t));
    rotate_area(board, logical_frame, area);
}

/* Display flushing */
static void disp_flush(lv_disp_drv_t *disp_drv, const lv_area_t *area, lv_color_t *color_p) {
    if (custom_rotation) {
        rotated_flush(disp_drv, area, color_p);
    } else {
        static_cast<Display *>(disp_drv->user_data)
            ->pushColors(area->x1, area->y1, area->x2 + 1, area->y2 + 1, reinterpret_cast<uint16_t *>(color_p));
    }
    lv_disp_flush_ready(disp_drv);
}

/*Read the touchpad*/
static void touchpad_read(lv_indev_drv_t *indev_driver, lv_indev_data_t *data) {
    static int16_t x, y;
    uint8_t touched = static_cast<Display *>(indev_driver->user_data)->getPoint(&x, &y, 1);
    if (touched) {
        if (custom_rotation)
            rotator.physicalToLogical(x, y, x, y);
        data->point.x = x;
        data->point.y = y;
        data->state = LV_INDEV_STATE_PR;
        return;
    }
    data->state = LV_INDEV_STATE_REL;
}

#if LV_USE_LOG
void lv_log_print_g_cb(const char *buf) {
    Serial.println(buf);
    Serial.flush();
}
#endif

String lvgl_helper_get_fs_filename(String filename) {
    static String path;
    path = String("A") + ":" + (filename);
    return path;
}

const char *lvgl_helper_get_fs_filename(const char *filename) {
    static String path;
    path = String("A") + ":" + String(filename);
    return path.c_str();
}

void beginLvglHelper(Display &board, bool debug) {

    lv_init();

#if LV_USE_LOG
    if (debug) {
        lv_log_register_print_cb(lv_log_print_g_cb);
    }
#endif

    size_t lv_buffer_size = board.width() * board.height() * sizeof(lv_color_t);
    buf = static_cast<lv_color_t *>(ps_malloc(lv_buffer_size));
    assert(buf);

    if (!board.supportsDirectMode()) {
        buf1 = static_cast<lv_color_t *>(ps_malloc(lv_buffer_size));
        assert(buf1);
    }

    lv_disp_draw_buf_init(&draw_buf, buf, buf1, board.width() * board.height());

    /*Initialize the display*/
    lv_disp_drv_init(&disp_drv);
    /* display resolution */
    disp_drv.hor_res = board.width();
    disp_drv.ver_res = board.height();
    disp_drv.flush_cb = disp_flush;
    disp_drv.draw_buf = &draw_buf;
    disp_drv.full_refresh = 0;
    disp_drv.direct_mode = board.supportsDirectMode();
    // Software rotation (used for 180 degree mounting) rewrites flush buffers
    // in place and is incompatible with direct_mode; this flag also doubles
    // as the "rotation supported" capability check consumed by DefaultUI, and
    // costs nothing extra while the display stays unrotated (LV_DISP_ROT_NONE).
    disp_drv.sw_rotate = board.supportsDirectMode() ? 0 : 1;
    disp_drv.user_data = &board;
    lv_disp_drv_register(&disp_drv);

    lv_indev_drv_init(&indev_drv);
    indev_drv.type = LV_INDEV_TYPE_POINTER;
    indev_drv.read_cb = touchpad_read;
    indev_drv.user_data = &board;
    lv_indev_drv_register(&indev_drv);
}

bool lvglHelperSetRotation(int degrees) {
    degrees = DisplayRotator::normalizeDegrees(degrees);
    lv_disp_t *disp = lv_disp_get_default();
    if (disp == nullptr || disp_drv.user_data == nullptr)
        return false;
    Display *board = static_cast<Display *>(disp_drv.user_data);

    // LVGL's own sw_rotate is cheaper and handles 180 on partial-mode panels;
    // everything else (any other angle, or direct-mode panels) uses the resampler.
    const bool useNative = degrees == 180 && disp_drv.sw_rotate;
    const bool useCustom = degrees != 0 && !useNative;

    if (useCustom) {
        const size_t frameBytes = board->width() * board->height() * sizeof(uint16_t);
        if (!board->supportsDirectMode() && logical_frame == NULL) {
            logical_frame = static_cast<uint16_t *>(ps_malloc(frameBytes));
            if (logical_frame == NULL)
                return false;
            memset(logical_frame, 0, frameBytes);
        }
        if (rotate_strip == NULL) {
            rotate_strip = static_cast<uint16_t *>(ps_malloc(board->width() * ROTATE_STRIP_ROWS * sizeof(uint16_t)));
            if (rotate_strip == NULL)
                return false;
        }
        rotator.configure(board->width(), board->height(), degrees);
    }

    lv_disp_set_rotation(disp, useNative ? LV_DISP_ROT_180 : LV_DISP_ROT_NONE);
    custom_rotation = useCustom;
    // Redraw everything so the logical frame is complete and the panel shows the new angle.
    lv_obj_invalidate(lv_scr_act());
    lv_obj_invalidate(lv_layer_top());
    lv_obj_invalidate(lv_layer_sys());
    return true;
}
