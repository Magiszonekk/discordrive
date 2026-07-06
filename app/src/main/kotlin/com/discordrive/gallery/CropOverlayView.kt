package com.discordrive.gallery

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.View

/**
 * Crop-frame overlay for the photo editor: a rectangle with draggable corners
 * (and drag-inside to move) constrained to the displayed image bounds. The
 * area outside the frame is dimmed; a rule-of-thirds grid aids framing.
 * The editor reads the result via [cropFraction] (normalized to the image).
 */
class CropOverlayView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) :
    View(context, attrs) {

    private val imageRect = RectF()
    private val cropRect = RectF()

    private val density = resources.displayMetrics.density
    private val touchRadius = 28f * density
    private val minSize = 56f * density
    private val handleRadius = 6f * density

    private val dimPaint = Paint().apply { color = 0x99000000.toInt() }
    private val borderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        style = Paint.Style.STROKE
        strokeWidth = 2f * density
    }
    private val gridPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        alpha = 110
        style = Paint.Style.STROKE
        strokeWidth = 1f * density
    }
    private val handlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }

    private enum class Drag { NONE, MOVE, TL, TR, BL, BR }
    private var drag = Drag.NONE
    private var lastX = 0f
    private var lastY = 0f

    /** Sets the on-screen bounds of the displayed image and resets the frame to cover it. */
    fun setImageRect(rect: RectF) {
        imageRect.set(rect)
        cropRect.set(rect)
        invalidate()
    }

    /**
     * Selected crop normalized to the image (0..1 on both axes), or null when
     * the frame still covers (almost) the whole image — i.e. nothing to crop.
     */
    fun cropFraction(): RectF? {
        if (imageRect.isEmpty) return null
        val f = RectF(
            (cropRect.left - imageRect.left) / imageRect.width(),
            (cropRect.top - imageRect.top) / imageRect.height(),
            (cropRect.right - imageRect.left) / imageRect.width(),
            (cropRect.bottom - imageRect.top) / imageRect.height(),
        )
        val almostAll = f.left < 0.01f && f.top < 0.01f && f.right > 0.99f && f.bottom > 0.99f
        return if (almostAll) null else f
    }

    override fun onDraw(canvas: Canvas) {
        if (imageRect.isEmpty) return
        // dim everything outside the crop frame
        canvas.drawRect(0f, 0f, width.toFloat(), cropRect.top, dimPaint)
        canvas.drawRect(0f, cropRect.bottom, width.toFloat(), height.toFloat(), dimPaint)
        canvas.drawRect(0f, cropRect.top, cropRect.left, cropRect.bottom, dimPaint)
        canvas.drawRect(cropRect.right, cropRect.top, width.toFloat(), cropRect.bottom, dimPaint)

        canvas.drawRect(cropRect, borderPaint)
        // rule-of-thirds grid
        val w3 = cropRect.width() / 3f
        val h3 = cropRect.height() / 3f
        canvas.drawLine(cropRect.left + w3, cropRect.top, cropRect.left + w3, cropRect.bottom, gridPaint)
        canvas.drawLine(cropRect.left + 2 * w3, cropRect.top, cropRect.left + 2 * w3, cropRect.bottom, gridPaint)
        canvas.drawLine(cropRect.left, cropRect.top + h3, cropRect.right, cropRect.top + h3, gridPaint)
        canvas.drawLine(cropRect.left, cropRect.top + 2 * h3, cropRect.right, cropRect.top + 2 * h3, gridPaint)
        // corner handles
        canvas.drawCircle(cropRect.left, cropRect.top, handleRadius, handlePaint)
        canvas.drawCircle(cropRect.right, cropRect.top, handleRadius, handlePaint)
        canvas.drawCircle(cropRect.left, cropRect.bottom, handleRadius, handlePaint)
        canvas.drawCircle(cropRect.right, cropRect.bottom, handleRadius, handlePaint)
    }

    @Suppress("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (imageRect.isEmpty) return false
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                drag = hitTest(event.x, event.y)
                lastX = event.x
                lastY = event.y
                return drag != Drag.NONE
            }
            MotionEvent.ACTION_MOVE -> {
                if (drag == Drag.NONE) return false
                val dx = event.x - lastX
                val dy = event.y - lastY
                lastX = event.x
                lastY = event.y
                applyDrag(dx, dy)
                invalidate()
                return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                drag = Drag.NONE
            }
        }
        return drag != Drag.NONE
    }

    private fun hitTest(x: Float, y: Float): Drag {
        fun near(px: Float, py: Float) =
            Math.hypot((x - px).toDouble(), (y - py).toDouble()) <= touchRadius
        return when {
            near(cropRect.left, cropRect.top) -> Drag.TL
            near(cropRect.right, cropRect.top) -> Drag.TR
            near(cropRect.left, cropRect.bottom) -> Drag.BL
            near(cropRect.right, cropRect.bottom) -> Drag.BR
            cropRect.contains(x, y) -> Drag.MOVE
            else -> Drag.NONE
        }
    }

    private fun applyDrag(dx: Float, dy: Float) {
        when (drag) {
            Drag.MOVE -> {
                val mx = dx.coerceIn(imageRect.left - cropRect.left, imageRect.right - cropRect.right)
                val my = dy.coerceIn(imageRect.top - cropRect.top, imageRect.bottom - cropRect.bottom)
                cropRect.offset(mx, my)
            }
            Drag.TL -> {
                cropRect.left = (cropRect.left + dx).coerceIn(imageRect.left, cropRect.right - minSize)
                cropRect.top = (cropRect.top + dy).coerceIn(imageRect.top, cropRect.bottom - minSize)
            }
            Drag.TR -> {
                cropRect.right = (cropRect.right + dx).coerceIn(cropRect.left + minSize, imageRect.right)
                cropRect.top = (cropRect.top + dy).coerceIn(imageRect.top, cropRect.bottom - minSize)
            }
            Drag.BL -> {
                cropRect.left = (cropRect.left + dx).coerceIn(imageRect.left, cropRect.right - minSize)
                cropRect.bottom = (cropRect.bottom + dy).coerceIn(cropRect.top + minSize, imageRect.bottom)
            }
            Drag.BR -> {
                cropRect.right = (cropRect.right + dx).coerceIn(cropRect.left + minSize, imageRect.right)
                cropRect.bottom = (cropRect.bottom + dy).coerceIn(cropRect.top + minSize, imageRect.bottom)
            }
            Drag.NONE -> {}
        }
    }
}
