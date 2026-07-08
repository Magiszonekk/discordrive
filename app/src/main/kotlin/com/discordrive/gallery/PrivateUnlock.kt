package com.discordrive.gallery

import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout

/**
 * Unlock gate for private albums: biometrics first (when enabled and
 * available), with the gallery PIN as the always-present fallback.
 * [onSuccess] fires once per call — "za każdym razem" by design, no
 * session-wide unlock cache.
 */
object PrivateUnlock {

    fun unlock(activity: AppCompatActivity, onSuccess: () -> Unit) {
        if (!PrivateAlbums.hasPin(activity)) { onSuccess(); return } // nothing to check against
        if (PrivateAlbums.biometricsEnabled(activity) && biometricsAvailable(activity)) {
            biometricPrompt(activity, onSuccess)
        } else {
            pinDialog(activity, onSuccess)
        }
    }

    fun biometricsAvailable(activity: AppCompatActivity): Boolean =
        BiometricManager.from(activity)
            .canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_WEAK) == BiometricManager.BIOMETRIC_SUCCESS

    private fun biometricPrompt(activity: AppCompatActivity, onSuccess: () -> Unit) {
        val prompt = BiometricPrompt(
            activity,
            ContextCompat.getMainExecutor(activity),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = onSuccess()

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    // the negative button is the PIN fallback; other errors just dismiss
                    if (errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON) pinDialog(activity, onSuccess)
                }
            },
        )
        prompt.authenticate(
            BiometricPrompt.PromptInfo.Builder()
                .setTitle(activity.getString(R.string.private_unlock_title))
                .setNegativeButtonText(activity.getString(R.string.private_use_pin))
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_WEAK)
                .build(),
        )
    }

    /**
     * Modal PIN entry, styled like the rest of the app (Material text field).
     * Validation happens without dismissing: a wrong code shows an inline
     * error and clears the field. Autofill is excluded in the layout — the
     * system password manager must not touch the PIN.
     */
    fun pinDialog(activity: AppCompatActivity, onSuccess: () -> Unit) {
        val view = activity.layoutInflater.inflate(R.layout.dialog_pin, null)
        val layout = view.findViewById<TextInputLayout>(R.id.pinLayout)
        val input = view.findViewById<TextInputEditText>(R.id.pinInput)
        val dialog = MaterialAlertDialogBuilder(activity)
            .setTitle(R.string.private_unlock_title)
            .setIcon(R.drawable.ic_lock)
            .setView(view)
            .setPositiveButton(android.R.string.ok, null) // validated below, dialog stays open on error
            .setNegativeButton(android.R.string.cancel, null)
            .create()
        dialog.setOnShowListener {
            val submit = {
                if (PrivateAlbums.verifyPin(activity, input.text?.toString().orEmpty())) {
                    dialog.dismiss()
                    onSuccess()
                } else {
                    // clear FIRST — setText fires the error-clearing watcher
                    input.setText("")
                    layout.error = activity.getString(R.string.private_pin_wrong)
                }
            }
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener { submit() }
            input.setOnEditorActionListener { _, actionId, _ ->
                if (actionId == EditorInfo.IME_ACTION_DONE) { submit(); true } else false
            }
            input.doOnTextChanged { layout.error = null }
            input.requestFocus()
        }
        dialog.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE)
        dialog.show()
    }

    private fun TextInputEditText.doOnTextChanged(block: () -> Unit) {
        addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = block()
            override fun afterTextChanged(s: android.text.Editable?) {}
        })
    }
}
