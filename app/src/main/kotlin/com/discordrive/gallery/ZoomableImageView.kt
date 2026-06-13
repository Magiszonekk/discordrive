package com.discordrive.gallery

import android.content.Context
import android.graphics.Matrix
import android.graphics.RectF
import android.util.AttributeSet
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import androidx.appcompat.widget.AppCompatImageView

/**
 * Gallery-style zoomable image: pinch-to-zoom, drag-to-pan, double-tap toggle.
 * Cooperates with a horizontal pager — while zoomed it keeps the gesture
 * (disallows parent intercept) so panning the photo doesn't flip pages.
 * A single tap is forwarded via [onSingleTap] (used to toggle the chrome).
 */
class ZoomableImageView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) :
    AppCompatImageView(context, attrs) {

    var onSingleTap: (() -> Unit)? = null

    private val baseMatrix = Matrix() // fit-center
    private val drawMatrix = Matrix() // base + user zoom/pan
    private val values = FloatArray(9)
    private val maxScale = 5f

    private val scaleDetector = ScaleGestureDetector(
        context,
        object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScale(detector: ScaleGestureDetector): Boolean {
                val rel = relativeScale()
                var factor = detector.scaleFactor
                if (rel * factor < 1f) factor = 1f / rel
                if (rel * factor > maxScale) factor = maxScale / rel
                drawMatrix.postScale(factor, factor, detector.focusX, detector.focusY)
                applyMatrix()
                return true
            }
        },
    )

    private val gestureDetector = GestureDetector(
        context,
        object : GestureDetector.SimpleOnGestureListener() {
            override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
                onSingleTap?.invoke()
                return true
            }

            override fun onDoubleTap(e: MotionEvent): Boolean {
                if (relativeScale() > 1.05f) {
                    drawMatrix.set(baseMatrix)
                } else {
                    drawMatrix.postScale(2.5f, 2.5f, e.x, e.y)
                }
                applyMatrix()
                return true
            }

            override fun onScroll(e1: MotionEvent?, e2: MotionEvent, dX: Float, dY: Float): Boolean {
                if (relativeScale() <= 1.01f) return false // not zoomed → let the pager swipe
                drawMatrix.postTranslate(-dX, -dY)
                applyMatrix()
                parent?.requestDisallowInterceptTouchEvent(true)
                return true
            }
        },
    )

    init {
        scaleType = ScaleType.MATRIX
    }

    override fun setImageBitmap(bm: android.graphics.Bitmap?) {
        super.setImageBitmap(bm)
        resetBase()
    }

    override fun setImageDrawable(drawable: android.graphics.drawable.Drawable?) {
        super.setImageDrawable(drawable)
        resetBase()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        resetBase()
    }

    @Suppress("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        scaleDetector.onTouchEvent(event)
        gestureDetector.onTouchEvent(event)
        if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
            if (relativeScale() <= 1f) parent?.requestDisallowInterceptTouchEvent(false)
        }
        return true
    }

    private fun resetBase() {
        val d = drawable ?: return
        val vw = width.toFloat()
        val vh = height.toFloat()
        val dw = d.intrinsicWidth.toFloat()
        val dh = d.intrinsicHeight.toFloat()
        if (vw <= 0 || vh <= 0 || dw <= 0 || dh <= 0) return
        val scale = minOf(vw / dw, vh / dh)
        baseMatrix.reset()
        baseMatrix.postScale(scale, scale)
        baseMatrix.postTranslate((vw - dw * scale) / 2f, (vh - dh * scale) / 2f)
        drawMatrix.set(baseMatrix)
        imageMatrix = drawMatrix
    }

    /** Current scale relative to the fit-center base (1f = fully zoomed out). */
    private fun relativeScale(): Float {
        drawMatrix.getValues(values)
        val cur = values[Matrix.MSCALE_X]
        baseMatrix.getValues(values)
        val base = values[Matrix.MSCALE_X]
        return if (base != 0f) cur / base else 1f
    }

    private fun applyMatrix() {
        clampToBounds()
        imageMatrix = drawMatrix
    }

    /** Keeps the image inside the view: pinned to edges when zoomed, centered otherwise. */
    private fun clampToBounds() {
        val d = drawable ?: return
        val rect = RectF(0f, 0f, d.intrinsicWidth.toFloat(), d.intrinsicHeight.toFloat())
        drawMatrix.mapRect(rect)
        var dx = 0f
        var dy = 0f
        val vw = width.toFloat()
        val vh = height.toFloat()
        dx = if (rect.width() <= vw) (vw - rect.width()) / 2f - rect.left
        else rect.left.let { if (it > 0) -it else 0f } + (if (rect.right < vw) vw - rect.right else 0f)
        dy = if (rect.height() <= vh) (vh - rect.height()) / 2f - rect.top
        else rect.top.let { if (it > 0) -it else 0f } + (if (rect.bottom < vh) vh - rect.bottom else 0f)
        drawMatrix.postTranslate(dx, dy)
    }
}
