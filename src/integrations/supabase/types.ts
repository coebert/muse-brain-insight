export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      ai_alert_actions: {
        Row: {
          action: string
          alert_category: string
          alert_confidence: string
          alert_id: string
          alert_severity: string
          alert_title: string
          cited_features: string[]
          context: string | null
          created_at: string
          escalated_to: string | null
          evidence_snapshot: Json
          id: string
          note: string | null
          override_rationale: string | null
          override_stance: string
          session_id: string | null
          user_id: string
        }
        Insert: {
          action: string
          alert_category?: string
          alert_confidence?: string
          alert_id: string
          alert_severity?: string
          alert_title?: string
          cited_features?: string[]
          context?: string | null
          created_at?: string
          escalated_to?: string | null
          evidence_snapshot?: Json
          id?: string
          note?: string | null
          override_rationale?: string | null
          override_stance?: string
          session_id?: string | null
          user_id: string
        }
        Update: {
          action?: string
          alert_category?: string
          alert_confidence?: string
          alert_id?: string
          alert_severity?: string
          alert_title?: string
          cited_features?: string[]
          context?: string | null
          created_at?: string
          escalated_to?: string | null
          evidence_snapshot?: Json
          id?: string
          note?: string | null
          override_rationale?: string | null
          override_stance?: string
          session_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_alert_actions_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "eeg_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_alert_feedback: {
        Row: {
          alert_category: string
          alert_confidence: string
          alert_id: string
          alert_severity: string
          alert_title: string
          clinician_label: string | null
          context: string | null
          created_at: string
          id: string
          model_version: string
          reason: string | null
          session_id: string | null
          user_id: string
          verdict: string
        }
        Insert: {
          alert_category?: string
          alert_confidence?: string
          alert_id: string
          alert_severity?: string
          alert_title?: string
          clinician_label?: string | null
          context?: string | null
          created_at?: string
          id?: string
          model_version?: string
          reason?: string | null
          session_id?: string | null
          user_id: string
          verdict: string
        }
        Update: {
          alert_category?: string
          alert_confidence?: string
          alert_id?: string
          alert_severity?: string
          alert_title?: string
          clinician_label?: string | null
          context?: string | null
          created_at?: string
          id?: string
          model_version?: string
          reason?: string | null
          session_id?: string | null
          user_id?: string
          verdict?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_alert_feedback_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "eeg_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      bis_model_versions: {
        Row: {
          coefficients: Json
          correlation_gain: number | null
          created_at: string
          data_digest: string | null
          id: string
          is_active: boolean
          lineage: string
          mae_gain: number | null
          metrics_after: Json | null
          metrics_before: Json | null
          note: string | null
          terms: Json
          training: Json | null
          user_id: string
          version: number
        }
        Insert: {
          coefficients: Json
          correlation_gain?: number | null
          created_at?: string
          data_digest?: string | null
          id?: string
          is_active?: boolean
          lineage: string
          mae_gain?: number | null
          metrics_after?: Json | null
          metrics_before?: Json | null
          note?: string | null
          terms: Json
          training?: Json | null
          user_id: string
          version: number
        }
        Update: {
          coefficients?: Json
          correlation_gain?: number | null
          created_at?: string
          data_digest?: string | null
          id?: string
          is_active?: boolean
          lineage?: string
          mae_gain?: number | null
          metrics_after?: Json | null
          metrics_before?: Json | null
          note?: string | null
          terms?: Json
          training?: Json | null
          user_id?: string
          version?: number
        }
        Relationships: []
      }
      bis_paired_points: {
        Row: {
          app_index: number
          app_sef: number | null
          app_sr: number | null
          at_seconds: number
          bis: number
          bis_sef: number | null
          bis_sr: number | null
          ce: Json
          context: string | null
          depth_confidence: number | null
          device: string | null
          external_ref: string | null
          feature_source: string
          features: Json
          id: string
          lag_seconds: number | null
          recorded_at: string
          reliable: boolean
          session_id: string | null
          source: string
          source_lineage: string | null
          source_site: string | null
          sqi: number | null
          stability: string | null
          user_id: string
        }
        Insert: {
          app_index: number
          app_sef?: number | null
          app_sr?: number | null
          at_seconds: number
          bis: number
          bis_sef?: number | null
          bis_sr?: number | null
          ce?: Json
          context?: string | null
          depth_confidence?: number | null
          device?: string | null
          external_ref?: string | null
          feature_source?: string
          features?: Json
          id?: string
          lag_seconds?: number | null
          recorded_at?: string
          reliable?: boolean
          session_id?: string | null
          source?: string
          source_lineage?: string | null
          source_site?: string | null
          sqi?: number | null
          stability?: string | null
          user_id: string
        }
        Update: {
          app_index?: number
          app_sef?: number | null
          app_sr?: number | null
          at_seconds?: number
          bis?: number
          bis_sef?: number | null
          bis_sr?: number | null
          ce?: Json
          context?: string | null
          depth_confidence?: number | null
          device?: string | null
          external_ref?: string | null
          feature_source?: string
          features?: Json
          id?: string
          lag_seconds?: number | null
          recorded_at?: string
          reliable?: boolean
          session_id?: string | null
          source?: string
          source_lineage?: string | null
          source_site?: string | null
          sqi?: number | null
          stability?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bis_paired_points_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "eeg_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      capture_epochs: {
        Row: {
          amplitude_uv: number | null
          artifact: boolean
          at_seconds: number
          bands: Json
          capture_id: string
          depth_index: number | null
          epoch_index: number
          epoch_suppression: number | null
          id: number
          quality_grade: string | null
          ratios: Json
          recorded_at: string
          sef95: number | null
          spectrum: Json
          sqi: number | null
          suppression_ratio: number | null
          total_power: number | null
          user_id: string
        }
        Insert: {
          amplitude_uv?: number | null
          artifact?: boolean
          at_seconds: number
          bands?: Json
          capture_id: string
          depth_index?: number | null
          epoch_index: number
          epoch_suppression?: number | null
          id?: number
          quality_grade?: string | null
          ratios?: Json
          recorded_at?: string
          sef95?: number | null
          spectrum?: Json
          sqi?: number | null
          suppression_ratio?: number | null
          total_power?: number | null
          user_id?: string
        }
        Update: {
          amplitude_uv?: number | null
          artifact?: boolean
          at_seconds?: number
          bands?: Json
          capture_id?: string
          depth_index?: number | null
          epoch_index?: number
          epoch_suppression?: number | null
          id?: number
          quality_grade?: string | null
          ratios?: Json
          recorded_at?: string
          sef95?: number | null
          spectrum?: Json
          sqi?: number | null
          suppression_ratio?: number | null
          total_power?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "capture_epochs_capture_id_fkey"
            columns: ["capture_id"]
            isOneToOne: false
            referencedRelation: "capture_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      capture_sessions: {
        Row: {
          capture_key: string
          created_at: string
          device_name: string | null
          epoch_count: number
          filed_session_id: string | null
          harvested_at: string | null
          harvested_session_id: string | null
          id: string
          last_seen_at: string
          lineage_key: string | null
          montage: string | null
          sample_rate: number | null
          started_at: string
          user_id: string
        }
        Insert: {
          capture_key: string
          created_at?: string
          device_name?: string | null
          epoch_count?: number
          filed_session_id?: string | null
          harvested_at?: string | null
          harvested_session_id?: string | null
          id?: string
          last_seen_at?: string
          lineage_key?: string | null
          montage?: string | null
          sample_rate?: number | null
          started_at?: string
          user_id?: string
        }
        Update: {
          capture_key?: string
          created_at?: string
          device_name?: string | null
          epoch_count?: number
          filed_session_id?: string | null
          harvested_at?: string | null
          harvested_session_id?: string | null
          id?: string
          last_seen_at?: string
          lineage_key?: string | null
          montage?: string | null
          sample_rate?: number | null
          started_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "capture_sessions_filed_session_id_fkey"
            columns: ["filed_session_id"]
            isOneToOne: false
            referencedRelation: "eeg_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "capture_sessions_harvested_session_id_fkey"
            columns: ["harvested_session_id"]
            isOneToOne: false
            referencedRelation: "eeg_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      case_note_facts: {
        Row: {
          confirmed: boolean
          created_at: string
          fields_sealed: string | null
          id: string
          session_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          confirmed?: boolean
          created_at?: string
          fields_sealed?: string | null
          id?: string
          session_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          confirmed?: boolean
          created_at?: string
          fields_sealed?: string | null
          id?: string
          session_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "case_note_facts_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "eeg_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      case_outcomes: {
        Row: {
          awareness: boolean
          created_at: string
          delirium: string
          delirium_days: number | null
          emergence: string
          id: string
          length_of_stay_days: number | null
          mortality_30d: boolean
          notes: string | null
          session_id: string
          unplanned_icu: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          awareness?: boolean
          created_at?: string
          delirium?: string
          delirium_days?: number | null
          emergence?: string
          id?: string
          length_of_stay_days?: number | null
          mortality_30d?: boolean
          notes?: string | null
          session_id: string
          unplanned_icu?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          awareness?: boolean
          created_at?: string
          delirium?: string
          delirium_days?: number | null
          emergence?: string
          id?: string
          length_of_stay_days?: number | null
          mortality_30d?: boolean
          notes?: string | null
          session_id?: string
          unplanned_icu?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "case_outcomes_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: true
            referencedRelation: "eeg_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      case_pattern_feedback: {
        Row: {
          created_at: string
          id: string
          pattern_key: string
          payload_sealed: string | null
          updated_at: string
          user_id: string
          verdict: string
        }
        Insert: {
          created_at?: string
          id?: string
          pattern_key: string
          payload_sealed?: string | null
          updated_at?: string
          user_id: string
          verdict?: string
        }
        Update: {
          created_at?: string
          id?: string
          pattern_key?: string
          payload_sealed?: string | null
          updated_at?: string
          user_id?: string
          verdict?: string
        }
        Relationships: []
      }
      coebis_locks: {
        Row: {
          alignment_id: string | null
          coefficients: Json
          created_at: string
          id: string
          is_active: boolean
          label: string
          lineage: string | null
          locked_at: string
          model_family: string
          model_version: number | null
          note: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          alignment_id?: string | null
          coefficients?: Json
          created_at?: string
          id?: string
          is_active?: boolean
          label?: string
          lineage?: string | null
          locked_at?: string
          model_family?: string
          model_version?: number | null
          note?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          alignment_id?: string | null
          coefficients?: Json
          created_at?: string
          id?: string
          is_active?: boolean
          label?: string
          lineage?: string | null
          locked_at?: string
          model_family?: string
          model_version?: number | null
          note?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "coebis_locks_alignment_id_fkey"
            columns: ["alignment_id"]
            isOneToOne: false
            referencedRelation: "depth_bis_alignments"
            referencedColumns: ["id"]
          },
        ]
      }
      coebis_model_versions: {
        Row: {
          coefficients: Json
          created_at: string
          data_digest: string
          id: string
          is_active: boolean
          lineage_key: string
          mae_gain: number | null
          metrics_after: Json
          metrics_before: Json
          model_family: string
          promoted: boolean
          reason: string | null
          run_id: string | null
          training: Json
          user_id: string
          version: number
        }
        Insert: {
          coefficients?: Json
          created_at?: string
          data_digest: string
          id?: string
          is_active?: boolean
          lineage_key: string
          mae_gain?: number | null
          metrics_after?: Json
          metrics_before?: Json
          model_family?: string
          promoted?: boolean
          reason?: string | null
          run_id?: string | null
          training?: Json
          user_id: string
          version: number
        }
        Update: {
          coefficients?: Json
          created_at?: string
          data_digest?: string
          id?: string
          is_active?: boolean
          lineage_key?: string
          mae_gain?: number | null
          metrics_after?: Json
          metrics_before?: Json
          model_family?: string
          promoted?: boolean
          reason?: string | null
          run_id?: string | null
          training?: Json
          user_id?: string
          version?: number
        }
        Relationships: []
      }
      coebis_refit_runs: {
        Row: {
          detail: Json
          error: string | null
          finished_at: string | null
          id: string
          lineages_considered: number
          lineages_refitted: number
          models_promoted: number
          rejected: Json
          started_at: string
          status: string
          summary: string | null
          trigger: string
          user_id: string
          validated_points: number
        }
        Insert: {
          detail?: Json
          error?: string | null
          finished_at?: string | null
          id?: string
          lineages_considered?: number
          lineages_refitted?: number
          models_promoted?: number
          rejected?: Json
          started_at?: string
          status?: string
          summary?: string | null
          trigger?: string
          user_id: string
          validated_points?: number
        }
        Update: {
          detail?: Json
          error?: string | null
          finished_at?: string | null
          id?: string
          lineages_considered?: number
          lineages_refitted?: number
          models_promoted?: number
          rejected?: Json
          started_at?: string
          status?: string
          summary?: string | null
          trigger?: string
          user_id?: string
          validated_points?: number
        }
        Relationships: []
      }
      coebis_refit_state: {
        Row: {
          cursor_user_id: string | null
          holder: string | null
          job_key: string
          last_error: string | null
          last_run_at: string | null
          lease_until: string | null
          paused_reason: string | null
          status: string
          updated_at: string
          users_processed: number
        }
        Insert: {
          cursor_user_id?: string | null
          holder?: string | null
          job_key: string
          last_error?: string | null
          last_run_at?: string | null
          lease_until?: string | null
          paused_reason?: string | null
          status?: string
          updated_at?: string
          users_processed?: number
        }
        Update: {
          cursor_user_id?: string | null
          holder?: string | null
          job_key?: string
          last_error?: string | null
          last_run_at?: string | null
          lease_until?: string | null
          paused_reason?: string | null
          status?: string
          updated_at?: string
          users_processed?: number
        }
        Relationships: []
      }
      dataset_intake_files: {
        Row: {
          bytes: number | null
          content_digest: string | null
          created_at: string
          dataset_version: string | null
          detail: string | null
          epochs: number
          file_name: string
          file_url: string
          harmonization_version: string | null
          id: string
          inserted: number
          licence: string | null
          licence_url: string | null
          lineage: string
          provenance: Json
          run_id: string
          source_id: string
          status: string
          user_id: string
        }
        Insert: {
          bytes?: number | null
          content_digest?: string | null
          created_at?: string
          dataset_version?: string | null
          detail?: string | null
          epochs?: number
          file_name: string
          file_url: string
          harmonization_version?: string | null
          id?: string
          inserted?: number
          licence?: string | null
          licence_url?: string | null
          lineage: string
          provenance?: Json
          run_id: string
          source_id: string
          status?: string
          user_id: string
        }
        Update: {
          bytes?: number | null
          content_digest?: string | null
          created_at?: string
          dataset_version?: string | null
          detail?: string | null
          epochs?: number
          file_name?: string
          file_url?: string
          harmonization_version?: string | null
          id?: string
          inserted?: number
          licence?: string | null
          licence_url?: string | null
          lineage?: string
          provenance?: Json
          run_id?: string
          source_id?: string
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      dataset_intake_runs: {
        Row: {
          created_at: string
          epochs_inserted: number
          files_ingested: number
          finished_at: string | null
          id: string
          sources_scanned: number
          started_at: string
          summary: Json
          user_id: string
        }
        Insert: {
          created_at?: string
          epochs_inserted?: number
          files_ingested?: number
          finished_at?: string | null
          id?: string
          sources_scanned?: number
          started_at?: string
          summary?: Json
          user_id: string
        }
        Update: {
          created_at?: string
          epochs_inserted?: number
          files_ingested?: number
          finished_at?: string | null
          id?: string
          sources_scanned?: number
          started_at?: string
          summary?: Json
          user_id?: string
        }
        Relationships: []
      }
      depth_bis_alignments: {
        Row: {
          auto_applied: boolean
          bias_after: number | null
          bias_before: number | null
          coefficients: Json
          created_at: string
          cv_metrics: Json
          gain: number
          id: string
          is_active: boolean
          knots: Json
          lineage: string | null
          lineage_detail: Json
          mae_after: number | null
          mae_before: number | null
          model_family: string
          model_version: string
          n_points: number
          n_sessions: number
          note: string | null
          offset: number
          user_id: string
        }
        Insert: {
          auto_applied?: boolean
          bias_after?: number | null
          bias_before?: number | null
          coefficients?: Json
          created_at?: string
          cv_metrics?: Json
          gain: number
          id?: string
          is_active?: boolean
          knots?: Json
          lineage?: string | null
          lineage_detail?: Json
          mae_after?: number | null
          mae_before?: number | null
          model_family?: string
          model_version?: string
          n_points: number
          n_sessions: number
          note?: string | null
          offset: number
          user_id: string
        }
        Update: {
          auto_applied?: boolean
          bias_after?: number | null
          bias_before?: number | null
          coefficients?: Json
          created_at?: string
          cv_metrics?: Json
          gain?: number
          id?: string
          is_active?: boolean
          knots?: Json
          lineage?: string | null
          lineage_detail?: Json
          mae_after?: number | null
          mae_before?: number | null
          model_family?: string
          model_version?: string
          n_points?: number
          n_sessions?: number
          note?: string | null
          offset?: number
          user_id?: string
        }
        Relationships: []
      }
      depth_calibrations: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          metrics: Json
          name: string
          params: Json
          source_session_ids: string[]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          metrics?: Json
          name: string
          params: Json
          source_session_ids?: string[]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          metrics?: Json
          name?: string
          params?: Json
          source_session_ids?: string[]
          user_id?: string
        }
        Relationships: []
      }
      depth_state_labels: {
        Row: {
          created_at: string
          end_seconds: number
          id: string
          label: string
          note: string | null
          session_id: string
          start_seconds: number
          user_id: string
        }
        Insert: {
          created_at?: string
          end_seconds: number
          id?: string
          label: string
          note?: string | null
          session_id: string
          start_seconds: number
          user_id: string
        }
        Update: {
          created_at?: string
          end_seconds?: number
          id?: string
          label?: string
          note?: string | null
          session_id?: string
          start_seconds?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "depth_state_labels_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "eeg_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      eeg_epochs: {
        Row: {
          bands: Json
          composite_components: Json | null
          consciousness_index: number | null
          created_at: string
          depth_components: Json | null
          depth_index: number | null
          depth_state: string | null
          entropy: Json | null
          id: number
          is_suppressed: boolean
          nociception_index: number | null
          power_ratios: Json | null
          seizure_score: number
          session_id: string
          spectral_edge_95: number
          spectrum: Json
          suppression_ratio: number
          t_offset_seconds: number
          total_power: number
          user_id: string
        }
        Insert: {
          bands?: Json
          composite_components?: Json | null
          consciousness_index?: number | null
          created_at?: string
          depth_components?: Json | null
          depth_index?: number | null
          depth_state?: string | null
          entropy?: Json | null
          id?: number
          is_suppressed?: boolean
          nociception_index?: number | null
          power_ratios?: Json | null
          seizure_score?: number
          session_id: string
          spectral_edge_95?: number
          spectrum?: Json
          suppression_ratio?: number
          t_offset_seconds: number
          total_power?: number
          user_id: string
        }
        Update: {
          bands?: Json
          composite_components?: Json | null
          consciousness_index?: number | null
          created_at?: string
          depth_components?: Json | null
          depth_index?: number | null
          depth_state?: string | null
          entropy?: Json | null
          id?: number
          is_suppressed?: boolean
          nociception_index?: number | null
          power_ratios?: Json | null
          seizure_score?: number
          session_id?: string
          spectral_edge_95?: number
          spectrum?: Json
          suppression_ratio?: number
          t_offset_seconds?: number
          total_power?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "eeg_epochs_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "eeg_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      eeg_events: {
        Row: {
          created_at: string
          detail: string | null
          duration_seconds: number
          id: number
          kind: string
          session_id: string
          severity: string
          t_offset_seconds: number
          user_id: string
        }
        Insert: {
          created_at?: string
          detail?: string | null
          duration_seconds?: number
          id?: number
          kind: string
          session_id: string
          severity?: string
          t_offset_seconds: number
          user_id: string
        }
        Update: {
          created_at?: string
          detail?: string | null
          duration_seconds?: number
          id?: number
          kind?: string
          session_id?: string
          severity?: string
          t_offset_seconds?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "eeg_events_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "eeg_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      eeg_sessions: {
        Row: {
          acute_class: string | null
          acute_pathology: string[]
          admission_diagnosis: string | null
          age_band: string | null
          age_years: number | null
          case_code: string
          case_summary: string | null
          chronic_burden: string | null
          chronic_cns: string | null
          chronic_conditions: string[]
          clinical_features: string[]
          context: string
          created_at: string
          deid_findings: Json
          device_name: string | null
          duration_seconds: number
          ended_at: string | null
          frailty: string | null
          id: string
          ketamine_detail: string | null
          ketamine_given: boolean | null
          location: string | null
          max_suppression_ratio: number
          mean_suppression_ratio: number
          notes: string | null
          patient_link_id: string | null
          patient_pseudonym: string | null
          regimen: string | null
          seizure_alerts: number
          sex: string | null
          started_at: string
          suppression_seconds: number
          user_id: string
        }
        Insert: {
          acute_class?: string | null
          acute_pathology?: string[]
          admission_diagnosis?: string | null
          age_band?: string | null
          age_years?: number | null
          case_code: string
          case_summary?: string | null
          chronic_burden?: string | null
          chronic_cns?: string | null
          chronic_conditions?: string[]
          clinical_features?: string[]
          context?: string
          created_at?: string
          deid_findings?: Json
          device_name?: string | null
          duration_seconds?: number
          ended_at?: string | null
          frailty?: string | null
          id?: string
          ketamine_detail?: string | null
          ketamine_given?: boolean | null
          location?: string | null
          max_suppression_ratio?: number
          mean_suppression_ratio?: number
          notes?: string | null
          patient_link_id?: string | null
          patient_pseudonym?: string | null
          regimen?: string | null
          seizure_alerts?: number
          sex?: string | null
          started_at?: string
          suppression_seconds?: number
          user_id: string
        }
        Update: {
          acute_class?: string | null
          acute_pathology?: string[]
          admission_diagnosis?: string | null
          age_band?: string | null
          age_years?: number | null
          case_code?: string
          case_summary?: string | null
          chronic_burden?: string | null
          chronic_cns?: string | null
          chronic_conditions?: string[]
          clinical_features?: string[]
          context?: string
          created_at?: string
          deid_findings?: Json
          device_name?: string | null
          duration_seconds?: number
          ended_at?: string | null
          frailty?: string | null
          id?: string
          ketamine_detail?: string | null
          ketamine_given?: boolean | null
          location?: string | null
          max_suppression_ratio?: number
          mean_suppression_ratio?: number
          notes?: string | null
          patient_link_id?: string | null
          patient_pseudonym?: string | null
          regimen?: string | null
          seizure_alerts?: number
          sex?: string | null
          started_at?: string
          suppression_seconds?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "eeg_sessions_patient_link_id_fkey"
            columns: ["patient_link_id"]
            isOneToOne: false
            referencedRelation: "patient_links"
            referencedColumns: ["id"]
          },
        ]
      }
      external_reference_points: {
        Row: {
          age_band: string | null
          asa: string | null
          at_seconds: number
          bis: number
          bis_emg: number | null
          bis_sef: number | null
          bis_sr: number | null
          case_ref: string
          ce: Json
          created_at: string
          external_ref: string
          frailty: string | null
          id: string
          regimen: string | null
          sex: string | null
          source: string
          source_lineage: string
          sqi: number | null
          user_id: string
        }
        Insert: {
          age_band?: string | null
          asa?: string | null
          at_seconds: number
          bis: number
          bis_emg?: number | null
          bis_sef?: number | null
          bis_sr?: number | null
          case_ref: string
          ce?: Json
          created_at?: string
          external_ref: string
          frailty?: string | null
          id?: string
          regimen?: string | null
          sex?: string | null
          source?: string
          source_lineage?: string
          sqi?: number | null
          user_id: string
        }
        Update: {
          age_band?: string | null
          asa?: string | null
          at_seconds?: number
          bis?: number
          bis_emg?: number | null
          bis_sef?: number | null
          bis_sr?: number | null
          case_ref?: string
          ce?: Json
          created_at?: string
          external_ref?: string
          frailty?: string | null
          id?: string
          regimen?: string | null
          sex?: string | null
          source?: string
          source_lineage?: string
          sqi?: number | null
          user_id?: string
        }
        Relationships: []
      }
      external_spectral_epochs: {
        Row: {
          at_seconds: number
          bands: Json
          case_ref: string
          channel: string | null
          covariates: Json
          created_at: string
          dataset_version: string | null
          epoch_seconds: number
          external_ref: string
          freq_start_hz: number
          freq_step_hz: number
          harmonization: Json
          harmonization_version: string | null
          harmonized_montage: string | null
          id: string
          is_suppressed: boolean
          label: string | null
          label_source: string
          sample_rate: number | null
          sef95: number | null
          source: string
          source_lineage: string
          spectrum_db: Json
          suppression_ratio: number | null
          total_power: number | null
          user_id: string
        }
        Insert: {
          at_seconds: number
          bands?: Json
          case_ref: string
          channel?: string | null
          covariates?: Json
          created_at?: string
          dataset_version?: string | null
          epoch_seconds?: number
          external_ref: string
          freq_start_hz?: number
          freq_step_hz?: number
          harmonization?: Json
          harmonization_version?: string | null
          harmonized_montage?: string | null
          id?: string
          is_suppressed?: boolean
          label?: string | null
          label_source?: string
          sample_rate?: number | null
          sef95?: number | null
          source: string
          source_lineage: string
          spectrum_db?: Json
          suppression_ratio?: number | null
          total_power?: number | null
          user_id: string
        }
        Update: {
          at_seconds?: number
          bands?: Json
          case_ref?: string
          channel?: string | null
          covariates?: Json
          created_at?: string
          dataset_version?: string | null
          epoch_seconds?: number
          external_ref?: string
          freq_start_hz?: number
          freq_step_hz?: number
          harmonization?: Json
          harmonization_version?: string | null
          harmonized_montage?: string | null
          id?: string
          is_suppressed?: boolean
          label?: string | null
          label_source?: string
          sample_rate?: number | null
          sef95?: number | null
          source?: string
          source_lineage?: string
          spectrum_db?: Json
          suppression_ratio?: number | null
          total_power?: number | null
          user_id?: string
        }
        Relationships: []
      }
      patient_context_notes: {
        Row: {
          baseline_sealed: string | null
          confounders_sealed: string | null
          context_sealed: string | null
          created_at: string
          id: string
          patient_key: string
          patient_label: string | null
          read_with_sealed: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          baseline_sealed?: string | null
          confounders_sealed?: string | null
          context_sealed?: string | null
          created_at?: string
          id?: string
          patient_key: string
          patient_label?: string | null
          read_with_sealed?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          baseline_sealed?: string | null
          confounders_sealed?: string | null
          context_sealed?: string | null
          created_at?: string
          id?: string
          patient_key?: string
          patient_label?: string | null
          read_with_sealed?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      patient_links: {
        Row: {
          created_at: string
          id: string
          identifier_fingerprint: string
          identifier_sealed: string
          label_sealed: string | null
          pseudonym: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          identifier_fingerprint: string
          identifier_sealed: string
          label_sealed?: string | null
          pseudonym: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          identifier_fingerprint?: string
          identifier_sealed?: string
          label_sealed?: string | null
          pseudonym?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      sef_alignments: {
        Row: {
          auto_applied: boolean
          bias_after: number | null
          bias_before: number | null
          coefficients: Json
          created_at: string
          cv_metrics: Json
          gain: number
          id: string
          is_active: boolean
          lineage: string | null
          mae_after: number | null
          mae_before: number | null
          model_family: string
          n_patients: number
          n_points: number
          n_sessions: number
          note: string | null
          offset: number
          user_id: string
        }
        Insert: {
          auto_applied?: boolean
          bias_after?: number | null
          bias_before?: number | null
          coefficients?: Json
          created_at?: string
          cv_metrics?: Json
          gain: number
          id?: string
          is_active?: boolean
          lineage?: string | null
          mae_after?: number | null
          mae_before?: number | null
          model_family?: string
          n_patients?: number
          n_points?: number
          n_sessions?: number
          note?: string | null
          offset: number
          user_id: string
        }
        Update: {
          auto_applied?: boolean
          bias_after?: number | null
          bias_before?: number | null
          coefficients?: Json
          created_at?: string
          cv_metrics?: Json
          gain?: number
          id?: string
          is_active?: boolean
          lineage?: string | null
          mae_after?: number | null
          mae_before?: number | null
          model_family?: string
          n_patients?: number
          n_points?: number
          n_sessions?: number
          note?: string | null
          offset?: number
          user_id?: string
        }
        Relationships: []
      }
      suppression_model_versions: {
        Row: {
          coefficients: Json
          created_at: string
          data_digest: string
          id: string
          is_active: boolean
          lineage: string
          mae_gain: number | null
          metrics_after: Json
          metrics_before: Json
          note: string | null
          sensitivity_gain: number | null
          training: Json
          user_id: string
          version: number
        }
        Insert: {
          coefficients: Json
          created_at?: string
          data_digest: string
          id?: string
          is_active?: boolean
          lineage: string
          mae_gain?: number | null
          metrics_after?: Json
          metrics_before?: Json
          note?: string | null
          sensitivity_gain?: number | null
          training?: Json
          user_id: string
          version: number
        }
        Update: {
          coefficients?: Json
          created_at?: string
          data_digest?: string
          id?: string
          is_active?: boolean
          lineage?: string
          mae_gain?: number | null
          metrics_after?: Json
          metrics_before?: Json
          note?: string | null
          sensitivity_gain?: number | null
          training?: Json
          user_id?: string
          version?: number
        }
        Relationships: []
      }
      tci_ce_points: {
        Row: {
          at_seconds: number
          created_at: string
          id: string
          infusion_id: string
          session_id: string | null
          targets: Json
          user_id: string
        }
        Insert: {
          at_seconds: number
          created_at?: string
          id?: string
          infusion_id: string
          session_id?: string | null
          targets?: Json
          user_id: string
        }
        Update: {
          at_seconds?: number
          created_at?: string
          id?: string
          infusion_id?: string
          session_id?: string | null
          targets?: Json
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tci_ce_points_infusion_id_fkey"
            columns: ["infusion_id"]
            isOneToOne: false
            referencedRelation: "tci_infusions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tci_ce_points_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "eeg_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      tci_infusions: {
        Row: {
          client_id: string
          created_at: string
          id: string
          model_key: string
          session_id: string | null
          started_seconds: number
          stopped_seconds: number | null
          user_id: string
        }
        Insert: {
          client_id: string
          created_at?: string
          id?: string
          model_key: string
          session_id?: string | null
          started_seconds?: number
          stopped_seconds?: number | null
          user_id: string
        }
        Update: {
          client_id?: string
          created_at?: string
          id?: string
          model_key?: string
          session_id?: string | null
          started_seconds?: number
          stopped_seconds?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tci_infusions_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "eeg_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      webauthn_challenges: {
        Row: {
          challenge: string
          created_at: string
          email: string
          expires_at: string
          id: string
          purpose: string
        }
        Insert: {
          challenge: string
          created_at?: string
          email: string
          expires_at?: string
          id?: string
          purpose: string
        }
        Update: {
          challenge?: string
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          purpose?: string
        }
        Relationships: []
      }
      webauthn_credentials: {
        Row: {
          backed_up: boolean
          counter: number
          created_at: string
          credential_id: string
          device_type: string | null
          id: string
          label: string | null
          last_used_at: string | null
          public_key: string
          transports: string[]
          user_id: string
        }
        Insert: {
          backed_up?: boolean
          counter?: number
          created_at?: string
          credential_id: string
          device_type?: string | null
          id?: string
          label?: string | null
          last_used_at?: string | null
          public_key: string
          transports?: string[]
          user_id: string
        }
        Update: {
          backed_up?: boolean
          counter?: number
          created_at?: string
          credential_id?: string
          device_type?: string | null
          id?: string
          label?: string | null
          last_used_at?: string | null
          public_key?: string
          transports?: string[]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      reference_coverage: {
        Args: never
        Returns: {
          case_count: number
          format_id: string
          row_count: number
        }[]
      }
      session_index_spread: {
        Args: never
        Returns: {
          max_index: number
          median_index: number
          min_index: number
          session_id: string
        }[]
      }
    }
    Enums: {
      app_role: "admin" | "clinician"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "clinician"],
    },
  },
} as const
