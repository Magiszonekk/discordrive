package com.discordrive.gallery

import android.text.InputType
import android.widget.EditText
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import com.google.android.material.dialog.MaterialAlertDialogBuilder

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

    /** Modal PIN entry; wrong code re-opens the dialog with an error hint. */
    fun pinDialog(activity: AppCompatActivity, onSuccess: () -> Unit, wrong: Boolean = false) {
        val input = EditText(activity).apply {
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            hint = activity.getString(R.string.private_unlock_pin_hint)
            if (wrong) error = activity.getString(R.string.private_pin_wrong)
        }
        MaterialAlertDialogBuilder(activity)
            .setTitle(R.string.private_unlock_title)
            .setView(input)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                if (PrivateAlbums.verifyPin(activity, input.text.toString())) {
                    onSuccess()
                } else {
                    pinDialog(activity, onSuccess, wrong = true)
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
        input.requestFocus()
    }
}
