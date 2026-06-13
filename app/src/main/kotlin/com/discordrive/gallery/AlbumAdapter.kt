package com.discordrive.gallery

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.card.MaterialCardView

data class Album(
    val name: String,
    val count: Int,
    val cover: MediaAsset?,
    val allVideo: Boolean,
    val isTrash: Boolean = false,
)

class AlbumAdapter(
    private val onClick: (Album) -> Unit,
) : RecyclerView.Adapter<AlbumAdapter.Holder>() {

    private var albums: List<Album> = emptyList()

    fun submit(newAlbums: List<Album>) {
        albums = newAlbums
        notifyDataSetChanged()
    }

    class Holder(view: View) : RecyclerView.ViewHolder(view) {
        val card: MaterialCardView = view.findViewById(R.id.albumCard)
        val cover: ImageView = view.findViewById(R.id.albumCover)
        val videoIcon: ImageView = view.findViewById(R.id.albumVideoIcon)
        val trashIcon: ImageView = view.findViewById(R.id.albumTrashIcon)
        val name: TextView = view.findViewById(R.id.albumName)
        val count: TextView = view.findViewById(R.id.albumCount)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
        val view = LayoutInflater.from(parent.context).inflate(R.layout.item_album, parent, false)
        val holder = Holder(view)
        // square covers, 2 columns
        holder.card.layoutParams = holder.card.layoutParams.apply {
            height = parent.measuredWidth / SPAN_COUNT - dp(view, 12)
        }
        return holder
    }

    override fun getItemCount() = albums.size

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val album = albums[position]
        val ctx = holder.itemView.context
        if (album.isTrash) {
            // plain themed tile with a centered trash icon (no photo preview)
            holder.cover.setImageDrawable(null)
            holder.cover.setBackgroundColor(ctx.getColor(R.color.surface_high))
            holder.trashIcon.visibility = View.VISIBLE
            holder.videoIcon.visibility = View.GONE
            holder.name.text = album.name
            holder.count.visibility = View.GONE
        } else {
            holder.trashIcon.visibility = View.GONE
            holder.count.visibility = View.VISIBLE
            holder.cover.setBackgroundColor(ctx.getColor(R.color.surface_high))
            album.cover?.let { ThumbLoader.load(ctx, it, holder.cover, 512) }
            holder.videoIcon.visibility = if (album.allVideo) View.VISIBLE else View.GONE
            holder.name.text = album.name
            holder.count.text = ctx.resources.getQuantityString(R.plurals.album_count, album.count, album.count)
        }
        holder.itemView.setOnClickListener { onClick(album) }
    }

    private fun dp(view: View, value: Int): Int =
        (value * view.resources.displayMetrics.density).toInt()

    companion object {
        const val SPAN_COUNT = 2
    }
}
