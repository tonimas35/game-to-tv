package io.gametotv.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.view.KeyEvent;
import org.junit.Test;

public class KeysTest {
    @Test
    public void okAndArrowsReachThePage() {
        assertEquals(KeyEvent.KEYCODE_ENTER, Keys.map(KeyEvent.KEYCODE_DPAD_CENTER));
        assertEquals(KeyEvent.KEYCODE_ENTER, Keys.map(KeyEvent.KEYCODE_ENTER));
        assertEquals(KeyEvent.KEYCODE_DPAD_LEFT, Keys.map(KeyEvent.KEYCODE_DPAD_LEFT));
        assertEquals(KeyEvent.KEYCODE_DPAD_DOWN, Keys.map(KeyEvent.KEYCODE_DPAD_DOWN));
    }

    @Test
    public void backIsHandledByTheActivity() {
        assertEquals(Keys.BACK, Keys.map(KeyEvent.KEYCODE_BACK));
        assertEquals(Keys.BACK, Keys.map(KeyEvent.KEYCODE_BUTTON_B));
    }

    @Test
    public void mediaKeys() {
        assertEquals(KeyEvent.KEYCODE_ENTER, Keys.map(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE));
        assertEquals(KeyEvent.KEYCODE_ESCAPE, Keys.map(KeyEvent.KEYCODE_MEDIA_STOP));
        assertEquals(KeyEvent.KEYCODE_DPAD_RIGHT, Keys.map(KeyEvent.KEYCODE_MEDIA_FAST_FORWARD));
        assertEquals(KeyEvent.KEYCODE_DPAD_LEFT, Keys.map(KeyEvent.KEYCODE_MEDIA_REWIND));
    }

    @Test
    public void systemKeysAreLeftAlone() {
        assertEquals(Keys.PASS, Keys.map(KeyEvent.KEYCODE_VOLUME_UP));
        assertEquals(Keys.PASS, Keys.map(KeyEvent.KEYCODE_VOLUME_MUTE));
        assertEquals(Keys.PASS, Keys.map(KeyEvent.KEYCODE_HOME));
        assertFalse(Keys.handled(KeyEvent.KEYCODE_POWER));
        assertTrue(Keys.handled(KeyEvent.KEYCODE_DPAD_CENTER));
    }
}
