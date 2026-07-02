package com.discordrive.gallery

import android.content.res.ColorStateList
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.core.widget.ImageViewCompat
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.color.MaterialColors
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Google-Photos-style grid: photos grouped by day with a full-width date
 * header above each group ("Dzisiaj" / "Wczoraj" / "wtorek, 1 lipca" /
 * "1 lipca 2025"). A day with few photos leaves the rest of its last row
 * empty, which breathes air into the grid. The layout manager must give
 * header positions a full span (see [isHeader]).
 */
class GalleryAdapter(
    private val onClick: (MediaAsset) -> Unit,
    private val onLongClick: ((MediaAsset) -> Unit)? = null,
) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {

    private sealed interface Row {
        data class Header(val label: String) : Row
        data class Media(val asset: MediaAsset) : Row
    }

    private var rows: List<Row> = emptyList()
    private var syncedAssetIds: Set<Long> = emptySet()
    private var selectionMode = false
    private var selectedIds: Set<Long> = emptySet()

    fun submit(newAssets: List<MediaAsset>, newSyncedIds: Set<Long>) {
        rows = buildRows(newAssets)
        syncedAssetIds = newSyncedIds
        notifyDataSetChanged()
    }

    /** Google-Photos-style selection: checked items shrink over an accent frame. */
    fun setSelection(mode: Boolean, ids: Set<Long>) {
        selectionMode = mode
        selectedIds = ids
        notifyDataSetChanged()
    }

    fun isHeader(position: Int): Boolean = rows.getOrNull(position) is Row.Header

    private fun buildRows(assets: List<MediaAsset>): List<Row> {
        val zone = ZoneId.systemDefault()
        val today = LocalDate.now(zone)
        val out = ArrayList<Row>(assets.size + 16)
        var lastDay: LocalDate? = null
        for (asset in assets) { // scanner order: newest first
            val day = Instant.ofEpochSecond(asset.dateAddedSec).atZone(zone).toLocalDate()
            if (day != lastDay) {
                out.add(Row.Header(dayLabel(day, today)))
                lastDay = day
            }
            out.add(Row.Media(asset))
        }
        return out
    }

    private fun dayLabel(day: LocalDate, today: LocalDate): String = when (day) {
        today -> todayLabel
        today.minusDays(1) -> yesterdayLabel
        else -> {
            val pattern = if (day.year == today.year) "EEEE, d MMMM" else "d MMMM yyyy"
            DateTimeFormatter.ofPattern(pattern, Locale.getDefault()).format(day)
                .replaceFirstChar { it.uppercase() }
        }
    }

    // Resolved lazily on first bind (adapter has no Context of its own).
    private var todayLabel = ""
    private var yesterdayLabel = ""

    class MediaHolder(view: View) : RecyclerView.ViewHolder(view) {
        val thumb: ImageView = view.findViewById(R.id.thumb)
        val playIcon: ImageView = view.findViewById(R.id.playIcon)
        val syncDot: ImageView = view.findViewById(R.id.syncDot)
        val checkBadge: ImageView = view.findViewById(R.id.checkBadge)
    }

    class HeaderHolder(view: View) : RecyclerView.ViewHolder(view) {
        val label: TextView = view.findViewById(R.id.dateHeader)
    }

    override fun getItemViewType(position: Int) =
        if (rows[position] is Row.Header) TYPE_HEADER else TYPE_MEDIA

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        if (todayLabel.isEmpty()) {
            todayLabel = parent.context.getString(R.string.date_today)
            yesterdayLabel = parent.context.getString(R.string.date_yesterday)
        }
        val inflater = LayoutInflater.from(parent.context)
        if (viewType == TYPE_HEADER) {
            return HeaderHolder(inflater.inflate(R.layout.item_date_header, parent, false))
        }
        val view = inflater.inflate(R.layout.item_media, parent, false)
        // square cells
        view.layoutParams = view.layoutParams.apply { height = parent.measuredWidth / SPAN_COUNT }
        return MediaHolder(view)
    }

    override fun getItemCount() = rows.size

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        val row = rows[position]
        if (holder is HeaderHolder) {
            holder.label.text = (row as Row.Header).label
            return
        }
        holder as MediaHolder
        val asset = (row as Row.Media).asset
        ThumbLoader.load(holder.itemView.context, asset, holder.thumb)
        holder.playIcon.visibility = if (asset.isVideo) View.VISIBLE else View.GONE

        // Synced = a small accent dot (bottom-right); unsynced items stay clean.
        val isSynced = asset.id in syncedAssetIds
        holder.syncDot.visibility = if (isSynced) View.VISIBLE else View.GONE
        if (isSynced) {
            // ImageViewCompat tints reliably on AppCompatImageView (plain imageTintList didn't take).
            ImageViewCompat.setImageTintList(
                holder.syncDot,
                ColorStateList.valueOf(MaterialColors.getColor(holder.syncDot, com.google.android.material.R.attr.colorPrimary)),
            )
        }

        val selected = selectionMode && asset.id in selectedIds
        holder.checkBadge.visibility = if (selectionMode) View.VISIBLE else View.GONE
        holder.checkBadge.setImageResource(if (selected) R.drawable.ic_check_circle else R.drawable.ic_circle_outline)
        val scale = if (selected) 0.82f else 1f
        holder.thumb.scaleX = scale
        holder.thumb.scaleY = scale
        holder.itemView.setBackgroundColor(
            if (selected) holder.itemView.context.getColor(R.color.accent_dim) else 0,
        )

        holder.itemView.setOnClickListener { onClick(asset) }
        onLongClick?.let { handler ->
            holder.itemView.setOnLongClickListener {
                handler(asset)
                true
            }
        }
    }

    companion object {
        const val SPAN_COUNT = 4
        private const val TYPE_HEADER = 0
        private const val TYPE_MEDIA = 1
    }
}
