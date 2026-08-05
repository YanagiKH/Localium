package dev.localium.android;

import android.app.Instrumentation;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.test.InstrumentationTestCase;

public final class LaunchSmokeTest extends InstrumentationTestCase {
    public void testLaunchActivity() throws Exception {
        Instrumentation instrumentation = getInstrumentation();
        PackageManager manager = instrumentation.getTargetContext().getPackageManager();
        Intent intent = manager.getLaunchIntentForPackage("dev.localium.android");
        assertNotNull(intent);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        assertNotNull(instrumentation.startActivitySync(intent));
    }
}
