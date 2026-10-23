package app.deepmv.client;

import android.graphics.Color;
import android.view.View;
import android.webkit.WebChromeClient;
import android.widget.FrameLayout;

/**
 * 视频全屏回调：WebView 里的 <video> 请求全屏时把 customView 挂到 decorView，
 * 否则手机上横屏播放只剩一小块。
 */
public class DeepMVFullscreen implements WebChromeClient.CustomViewCallback {

    private final android.app.Activity activity;
    private View customView;

    public DeepMVFullscreen(android.app.Activity activity) {
        this.activity = activity;
    }

    public void show(View view, WebChromeClient.CustomViewCallback callback) {
        this.customView = view;
        FrameLayout decor = activity.findViewById(android.R.id.content);
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT);
        decor.addView(view, params);
        view.setBackgroundColor(Color.BLACK);
    }

    public void hide() {
        if (customView == null) return;
        FrameLayout decor = activity.findViewById(android.R.id.content);
        decor.removeView(customView);
        customView = null;
    }

    @Override
    public void onCustomViewHidden() {
        hide();
    }
}
