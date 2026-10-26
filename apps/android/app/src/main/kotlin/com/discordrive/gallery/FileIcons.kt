package com.discordrive.gallery

import androidx.annotation.DrawableRes

/** The icon of an item by its kind (folder, picture, video, audio, document, archive, other). */
object FileIcons {
    private val pictures = setOf("jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "avif", "tif", "tiff", "dng", "raw")
    private val videos = setOf("mp4", "mkv", "mov", "webm", "avi", "m4v", "3gp", "ts")
    private val audio = setOf("mp3", "m4a", "flac", "wav", "ogg", "opus", "aac")
    private val docs = setOf("txt", "md", "pdf", "doc", "docx", "odt", "rtf", "csv", "xls", "xlsx", "ods", "ppt", "pptx", "json", "xml", "html")
    private val archives = setOf("zip", "7z", "rar", "tar", "gz", "xz", "bz2", "zst")

    @DrawableRes
    fun of(name: String, folder: Boolean): Int {
        if (folder) return R.drawable.ic_cobalt_folder
        return when (name.substringAfterLast('.', "").lowercase()) {
            in pictures -> R.drawable.ic_photo
            in videos -> R.drawable.ic_play
            in audio -> R.drawable.ic_cobalt_audio
            in docs -> R.drawable.ic_cobalt_doc
            in archives -> R.drawable.ic_cobalt_archive
            else -> R.drawable.ic_cobalt_file
        }
    }
}
