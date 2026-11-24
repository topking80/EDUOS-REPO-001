package org.eduos.eduos_mobile_branding

import android.app.UiModeManager
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Build
import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity() {
    /**
     * Tells the Dart side what kind of screen this is before the first frame
     * (lib/core/device_profile.dart, DeviceProfile.fromLaunch):
     *   "tv"        Android TV / Google TV / Fire TV (television UI mode or leanback)
     *   "fire_tv"   an Amazon Fire TV device
     *   "model=..." the device model, shown to the person approving device sign-in
     */
    override fun getDartEntrypointArgs(): List<String>? {
        val args = mutableListOf<String>()
        super.getDartEntrypointArgs()?.let { args.addAll(it) }
        val uiMode = getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager
        val television = uiMode?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION ||
            packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK)
        val fireTv = packageManager.hasSystemFeature("amazon.hardware.fire_tv")
        if (television || fireTv) args.add("tv")
        if (fireTv) args.add("fire_tv")
        args.add("model=" + Build.MODEL.take(60))
        return args
    }
}
