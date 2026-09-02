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
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
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
    Enums: {},
  },
} as const
