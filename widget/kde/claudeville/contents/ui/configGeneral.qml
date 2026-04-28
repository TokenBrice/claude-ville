import QtQuick
import org.kde.kirigami as Kirigami
import org.kde.plasma.components as PlasmaComponents

Kirigami.FormLayout {
    PlasmaComponents.TextField {
        Kirigami.FormData.label: i18n("Server URL:")
        text: plasmoid.configuration.serverUrl
        onTextChanged: plasmoid.configuration.serverUrl = text
    }

    PlasmaComponents.SpinBox {
        Kirigami.FormData.label: i18n("Refresh interval:")
        from: 1000
        to: 60000
        stepSize: 1000
        value: plasmoid.configuration.refreshIntervalMs
        textFromValue: function(value) {
            return i18n("%1 s", Math.round(value / 1000))
        }
        valueFromText: function(text) {
            var parsed = Number(String(text).replace(/[^0-9]/g, ""))
            return isFinite(parsed) ? parsed * 1000 : 5000
        }
        onValueChanged: plasmoid.configuration.refreshIntervalMs = value
    }
}
