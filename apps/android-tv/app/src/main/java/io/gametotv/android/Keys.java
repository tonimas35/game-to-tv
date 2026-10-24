package io.gametotv.android;

import android.view.KeyEvent;

/**
 * Remote control keys -> what the TV page understands (public/lib/keys.js:
 * arrows 37-40, OK = Enter 13, Back = Escape 27).
 *
 * Pure int mapping (no Android calls) so it can be unit tested on the JVM.
 * The WebView turns the mapped Android key codes into the usual DOM key
 * events: KEYCODE_DPAD_LEFT -> keyCode 37 «ArrowLeft», KEYCODE_ENTER -> 13
 * «Enter», KEYCODE_ESCAPE -> 27 «Escape».
 */
final class Keys {
    private Keys() {}

    /** What MainActivity does with a key. */
    static final int PASS = 0;      // let Android / the WebView handle it as is
    static final int BACK = -1;     // Back logic (Escape to the page, or exit from the main menu)

    /**
     * Returns PASS, BACK or the Android key code to send to the WebView instead.
     * Volume, mute, home, power, input… are never touched (PASS).
     */
    static int map(int keyCode) {
        switch (keyCode) {
            // Arrows: the WebView already maps them, but being explicit keeps
            // the page working if a TV sends odd variants (diagonals, gamepads)
            case KeyEvent.KEYCODE_DPAD_UP:
            case KeyEvent.KEYCODE_DPAD_DOWN:
            case KeyEvent.KEYCODE_DPAD_LEFT:
            case KeyEvent.KEYCODE_DPAD_RIGHT:
                return keyCode;
            case KeyEvent.KEYCODE_DPAD_UP_LEFT:
            case KeyEvent.KEYCODE_DPAD_DOWN_LEFT:
                return KeyEvent.KEYCODE_DPAD_LEFT;
            case KeyEvent.KEYCODE_DPAD_UP_RIGHT:
            case KeyEvent.KEYCODE_DPAD_DOWN_RIGHT:
                return KeyEvent.KEYCODE_DPAD_RIGHT;

            // OK: the D-pad centre may reach a web page as Enter or not at all
            // depending on the WebView version, so always send a real Enter
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER:
            case KeyEvent.KEYCODE_BUTTON_A:
            case KeyEvent.KEYCODE_BUTTON_SELECT:
                return KeyEvent.KEYCODE_ENTER;

            // Back: handled by MainActivity (Escape to the page, double Back to exit)
            case KeyEvent.KEYCODE_BACK:
            case KeyEvent.KEYCODE_BUTTON_B:
            case KeyEvent.KEYCODE_ESCAPE:
                return BACK;

            // Media keys on TV remotes: play/pause acts as OK, stop as Back
            // (the page asks before leaving a game), rewind/forward as arrows
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY:
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
                return KeyEvent.KEYCODE_ENTER;
            case KeyEvent.KEYCODE_MEDIA_STOP:
                return KeyEvent.KEYCODE_ESCAPE;
            case KeyEvent.KEYCODE_MEDIA_REWIND:
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
                return KeyEvent.KEYCODE_DPAD_LEFT;
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
            case KeyEvent.KEYCODE_MEDIA_NEXT:
                return KeyEvent.KEYCODE_DPAD_RIGHT;
            case KeyEvent.KEYCODE_CHANNEL_UP:
            case KeyEvent.KEYCODE_PAGE_UP:
                return KeyEvent.KEYCODE_DPAD_UP;
            case KeyEvent.KEYCODE_CHANNEL_DOWN:
            case KeyEvent.KEYCODE_PAGE_DOWN:
                return KeyEvent.KEYCODE_DPAD_DOWN;
            default:
                return PASS;
        }
    }

    /** Is this a key we must swallow so it never reaches the system (e.g. media session)? */
    static boolean handled(int keyCode) {
        return map(keyCode) != PASS;
    }
}
