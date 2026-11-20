{{- define "logto.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 52 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 52 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "logto.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "logto.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}

{{- define "logto.dbEnv" -}}
- name: DB_URL
  valueFrom:
    secretKeyRef:
      name: {{ required "database.existingSecret is required" .Values.database.existingSecret | quote }}
      key: {{ .Values.database.secretKey | quote }}
{{- end -}}

{{- define "logto.writableMounts" -}}
- name: alteration-scripts
  mountPath: /etc/logto/packages/cli/alteration-scripts
- name: tmp
  mountPath: /tmp
{{- end -}}

{{- define "logto.writableVolumes" -}}
- name: alteration-scripts
  emptyDir: {}
- name: tmp
  emptyDir: {}
{{- end -}}
