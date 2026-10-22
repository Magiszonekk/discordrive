package com.discordrive.gallery

import android.content.Context
import android.util.AttributeSet
import android.view.View
import com.google.android.material.textfield.TextInputEditText

/**
 * PIN field that is invisible to autofill at the framework level.
 * `importantForAutofill="no"` is only a HINT and Google Password Manager
 * ignores it for password-looking fields — it kept offering to save the
 * folder PIN as the DiscorDrive login password and autofilled the login
 * password into the PIN box. AUTOFILL_TYPE_NONE removes the field from the
 * autofill session entirely: nothing to fill, no value collected to save.
 */
class PinEditText @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) :
    TextInputEditText(context, attrs) {

    override fun getAutofillType(): Int = View.AUTOFILL_TYPE_NONE
}
